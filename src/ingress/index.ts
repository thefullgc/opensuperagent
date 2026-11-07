import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { DataPaths } from "../paths.js";
import type { Store } from "../storage/index.js";
import type { IngressInput, Trigger } from "../types.js";
import { newId } from "../ids.js";
import { decideRoute, type RouteDecision } from "./route.js";

export { decideRoute, type RouteDecision } from "./route.js";

export interface IngressResult {
  trigger: Trigger;
  duplicate: boolean;
  decision: RouteDecision | null;
  inboxItemId: string | null;
  inboxItemIds: string[];
}

export class Ingress {
  constructor(
    private readonly store: Store,
    private readonly paths: DataPaths,
    private readonly config: AppConfig,
    private readonly sourceAllowed?: (source: string) => boolean,
  ) {}

  /**
   * Validate source → persist Trigger + route Inbox Item in one transaction → ACK.
   * P1: persist before ACK (caller ACKs only after this returns success).
   */
  accept(input: IngressInput): IngressResult {
    if (!this.isSourceAllowed(input.source)) {
      return this.ignore(input, "source not in config.sources");
    }

    if (
      input.externalId &&
      this.store.deliveries.hasExternalMessageId(input.externalId)
    ) {
      return this.ignore(input, "echo of outbound message");
    }

    const existing = this.store.triggers.findByExternal(
      input.source,
      input.externalId,
    );
    if (existing) {
      return {
        trigger: existing,
        duplicate: true,
        decision: null,
        inboxItemId: null,
        inboxItemIds: [],
      };
    }

    return this.store.transaction(() => {
      const payloadRef = this.writePayload(input);
      const decision = decideRoute(this.store, {
        taskId: input.taskId,
        threadId: input.threadId,
        control: input.control,
      });

      const trigger = this.store.triggers.insert({
        source: input.source,
        externalId: input.externalId,
        threadId: input.threadId,
        actorId: input.actorId,
        payloadRef,
        preview: input.preview,
        status: "routed",
      });
      // Control path is executed by App immediately, without an inbox item.
      if (decision.kind === "control") {
        return {
          trigger,
          duplicate: false,
          decision,
          inboxItemId: null,
          inboxItemIds: [],
        };
      }

      // A shared Thread can have several open subscribers. Fan out one durable
      // inbox row per subscriber; each Worker keeps its own isolated context.
      const targets =
        decision.kind === "task"
          ? [decision.taskId]
          : decision.kind === "tasks"
            ? decision.taskIds
            : ["router"];
      const items = targets.map(
        (target) =>
          this.store.inbox.insertOrGet({
            target,
            triggerId: trigger.id,
            steer: input.steer,
          }).item,
      );
      return {
        trigger,
        duplicate: false,
        decision,
        inboxItemId: items[0]?.id ?? null,
        inboxItemIds: items.map((item) => item.id),
      };
    });
  }

  private ignore(input: IngressInput, reason: string): IngressResult {
    return this.store.transaction(() => {
      const existing = this.store.triggers.findByExternal(
        input.source,
        input.externalId,
      );
      if (existing) {
        return {
          trigger: existing,
          duplicate: true,
          decision: { kind: "ignore", reason },
          inboxItemId: null,
          inboxItemIds: [],
        };
      }
      const payloadRef = this.writePayload(input);
      const trigger = this.store.triggers.insert({
        source: input.source,
        externalId: input.externalId,
        threadId: input.threadId,
        actorId: input.actorId,
        payloadRef,
        preview: input.preview,
        status: "ignored",
      });
      return {
        trigger,
        duplicate: false,
        decision: { kind: "ignore", reason },
        inboxItemId: null,
        inboxItemIds: [],
      };
    });
  }

  private isSourceAllowed(source: string): boolean {
    return this.sourceAllowed
      ? this.sourceAllowed(source)
      : this.config.sources.some((s) => s.source === source);
  }

  private writePayload(input: IngressInput): string {
    mkdirSync(this.paths.blobs, { recursive: true });
    const ref = `${newId("blob")}.json`;
    writeFileSync(
      join(this.paths.blobs, ref),
      JSON.stringify(input.payload ?? { preview: input.preview }, null, 2),
    );
    return ref;
  }
}
