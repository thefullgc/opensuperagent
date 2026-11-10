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
      if (input.threadId)
        this.store.threads.ensure({
          id: input.threadId,
          source: input.source,
          externalKey: input.threadId,
        });
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
      // Only an explicit new message to this Task authorizes retrying failed work.
      if (input.taskId && !input.control) this.store.tasks.retry(input.taskId);
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
      let threadSeq: number | null = null;
      if (input.threadId) {
        this.store.threads.ensure({
          id: input.threadId,
          source: input.source,
          externalKey: input.threadId,
        });
        const event = this.store.threads.appendEvent({
          threadId: input.threadId,
          triggerId: trigger.id,
          kind: "trigger",
          summary: input.preview.slice(0, 240),
          payloadRef,
        });
        threadSeq = event.seq;
      }

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

      // Executors get actionable inbox rows; observers get the same Thread
      // event as a non-executable observation, never a pending Worker run.
      const executors =
        decision.kind === "task"
          ? [decision.taskId]
          : decision.kind === "tasks"
            ? decision.taskIds
            : ["router"];
      const observers = decision.observerTaskIds ?? [];
      const items = [
        ...executors.map(
          (target) =>
            this.store.inbox.insertOrGet({
              target,
              triggerId: trigger.id,
              steer: input.steer,
            }).item,
        ),
        ...observers.map(
          (target) =>
            this.store.inbox.insertOrGet({
              target,
              triggerId: trigger.id,
              mode: "observe",
            }).item,
        ),
      ];
      if (threadSeq !== null && input.threadId) {
        for (const target of [...executors, ...observers]) {
          if (target !== "router")
            this.store.tasks.advanceCursor(target, input.threadId, threadSeq);
        }
      }
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
