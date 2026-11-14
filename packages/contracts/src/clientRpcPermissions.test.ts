import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthSettingsWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { OrchestrationResolveTaskRetroInput } from "./taskRetro.ts";

const isResolveTaskRetroInput = Schema.is(OrchestrationResolveTaskRetroInput);

const resolve = (action: "apply" | "dismiss") =>
  clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.resolveTaskRetro, {
    threadId: "thread:one",
    recommendationId: "rec-1",
    action,
  });

it("applying a retro recommendation also needs the right to write settings", () => {
  expect(resolve("apply")).toEqual([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
});

it("checks retro permissions before a recommendation is available", () => {
  for (const action of ["apply", "dismiss"] as const) {
    const expected =
      action === "apply"
        ? [AuthOrchestrationOperateScope, AuthSettingsWriteScope]
        : [AuthOrchestrationOperateScope];
    const placeholder = { threadId: "thread:one", recommendationId: "", action };
    expect(
      clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.resolveTaskRetro, placeholder),
    ).toEqual(expected);
    expect(
      clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.resolveTaskRetro, { action }),
    ).toEqual(expected);
    expect(isResolveTaskRetroInput(placeholder)).toBe(false);
  }
});

it("dismissing one, and running a retro, need only the right to operate threads", () => {
  expect(resolve("dismiss")).toEqual([AuthOrchestrationOperateScope]);
  expect(clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.runTaskRetro, undefined)).toEqual([
    AuthOrchestrationOperateScope,
  ]);
});
