import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { backgroundWaitTaskIds, OrchestratorToolkit } from "./tools.ts";

// Agents read "call t3_background_wait with its task id" and pass {taskId}; 20 calls failed on it.
it("t3_background_wait takes a single taskId as well as taskIds, and one of them", () => {
  const schema = OrchestratorToolkit.tools.t3_background_wait.parametersSchema;
  const decode = Schema.decodeUnknownExit(schema);
  const idsOf = (input: unknown) => {
    const exit = decode(input);
    return Exit.isSuccess(exit) ? backgroundWaitTaskIds(exit.value) : "rejected";
  };
  expect(idsOf({ taskId: "x" })).toEqual(["x"]);
  expect(idsOf({ taskIds: ["x"] })).toEqual(["x"]);
  expect(idsOf({ taskId: "x" })).toEqual(idsOf({ taskIds: ["x"] }));
  // Both given: one list, without repeating an id.
  expect(idsOf({ taskId: "b", taskIds: ["a", "b"] })).toEqual(["a", "b"]);
  expect(idsOf({ taskId: "x", waiting: false })).toEqual(["x"]);
  expect(idsOf({})).toBeUndefined();
  expect(idsOf({ taskIds: [] })).toBe("rejected");
  expect(idsOf({ taskId: "  " })).toBe("rejected");
});

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});
