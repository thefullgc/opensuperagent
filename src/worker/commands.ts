import { parseArgs } from "node:util";
import type { CliCommandDefinition } from "@tomsun28/pizza/sdk";
import type { WorkerControls } from "./controls.js";
import type { SubmitOutcome } from "../types.js";
import { validateToolArguments } from "../llm/tool-validation.js";

const RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["completed", "failed", "needs_input"] },
    notice: { type: "string" },
    summary: { type: "string" },
    artifacts: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "notice", "summary"],
  additionalProperties: false,
};

function validateResult(value: unknown): Record<string, unknown> {
  const invalid = validateToolArguments(value, RESULT_SCHEMA);
  if (invalid) throw new Error(`Invalid _submit_result arguments: ${invalid}`);
  return value as Record<string, unknown>;
}

function parseResult(args: string[], heredoc?: string): Record<string, unknown> {
  if (heredoc !== undefined) {
    if (args.length !== 1 || args[0] !== "--json")
      throw new Error("_submit_result: use --json with a JSON heredoc; do not mix it with other flags");
    return validateResult(JSON.parse(heredoc));
  }
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      json: { type: "string" },
      outcome: { type: "string" },
      notice: { type: "string" },
      summary: { type: "string" },
      artifact: { type: "string", multiple: true },
    },
  });
  if (values.json !== undefined) {
    if (Object.keys(values).length !== 1)
      throw new Error("_submit_result: --json cannot be combined with other flags");
    return validateResult(JSON.parse(values.json));
  }
  const { artifact, ...result } = values;
  return validateResult({ ...result, ...(artifact ? { artifacts: artifact } : {}) });
}

/** A fixed task command dispatched by Pizza's native CLI before shell fallback. */
export function submitResultCommand(input: {
  controls: WorkerControls;
  taskId: string;
  sessionId: string;
  runId: () => string;
}): CliCommandDefinition<Record<string, unknown>> {
  return {
    name: "_submit_result",
    description: "Submit this Task's result and notify its user.",
    help: [
      "_submit_result --outcome completed|failed|needs_input --notice TEXT --summary TEXT [--artifact PATH ...]",
      "Or: _submit_result --json '<JSON object>'",
      "Or: _submit_result --json <<'RESULT'\n{\"outcome\":\"completed\",\"notice\":\"Done\",\"summary\":\"Verified\",\"artifacts\":[]}\nRESULT",
      "Completed requires no running server operation and no pending input. Task, session and Run IDs are supplied by the system.",
    ].join("\n"),
    parseArguments: parseResult,
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = validateResult(params);
      const result = input.controls.submitResult({
        taskId: input.taskId,
        sessionId: input.sessionId,
        runId: input.runId(),
        toolCallId,
        outcome: args.outcome as SubmitOutcome,
        notice: args.notice as string,
        summary: args.summary as string,
        artifacts: args.artifacts as string[] | undefined,
      });
      return {
        details: { result },
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  };
}
