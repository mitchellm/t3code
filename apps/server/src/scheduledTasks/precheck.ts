import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";

export const PRECHECK_STDOUT_LIMIT_BYTES = 8 * 1024;
const PRECHECK_STDERR_TAIL_BYTES = 2 * 1024;
// Collect more than we show, so the tail of stderr is the real tail.
const PRECHECK_COLLECT_LIMIT_BYTES = 64 * 1024;

export interface PrecheckRequest {
  readonly command: string;
  readonly timeoutMs: number;
  readonly projectId: ProjectId;
  /** The bound thread, whose worktree is the working directory. Null: the project folder. */
  readonly threadId: ThreadId | null;
}

export type PrecheckRaw =
  | {
      readonly _tag: "exited";
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "timedOut"; readonly timeoutMs: number }
  | { readonly _tag: "failed"; readonly message: string };

export type PrecheckVerdict =
  | { readonly _tag: "quiet" }
  | { readonly _tag: "news"; readonly section: string }
  | { readonly _tag: "error"; readonly section: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function headBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return { text: decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, ""), truncated: true };
}

function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: decoder.decode(bytes.subarray(bytes.length - maxBytes)).replace(/^�+/, ""),
    truncated: true,
  };
}

const oneLine = (command: string) => command.replace(/\s+/g, " ").trim();

/**
 * Exit 0 with output is news. Exit 0 without output is quiet. Anything else
 * becomes an error section: a broken precheck must surface, not hide the task.
 */
export function interpretPrecheck(command: string, raw: PrecheckRaw): PrecheckVerdict {
  const label = `\`${oneLine(command)}\``;
  if (raw._tag === "exited" && raw.code === 0) {
    if (raw.stdout.trim() === "") return { _tag: "quiet" };
    const shown = headBytes(raw.stdout.trim(), PRECHECK_STDOUT_LIMIT_BYTES);
    return {
      _tag: "news",
      section: [
        "## Precheck output",
        `The precheck ${label} found something new. Its output:`,
        "",
        shown.text,
        ...(shown.truncated
          ? ["", `(Output truncated to the first ${PRECHECK_STDOUT_LIMIT_BYTES} bytes.)`]
          : []),
      ].join("\n"),
    };
  }
  const problem =
    raw._tag === "timedOut"
      ? `timed out after ${Math.round(raw.timeoutMs / 1000)}s`
      : raw._tag === "failed"
        ? `could not run: ${raw.message}`
        : `exited with code ${raw.code ?? "unknown"}`;
  const lines = ["## Precheck failed", `The precheck ${label} ${problem}.`];
  if (raw._tag === "exited") {
    const stderr = tailBytes(raw.stderr.trim(), PRECHECK_STDERR_TAIL_BYTES);
    if (stderr.text !== "") {
      lines.push("", stderr.truncated ? "stderr (tail):" : "stderr:", stderr.text);
    }
    const stdout = headBytes(raw.stdout.trim(), PRECHECK_STDERR_TAIL_BYTES);
    if (stdout.text !== "") {
      lines.push("", stdout.truncated ? "stdout (start):" : "stdout:", stdout.text);
    }
  }
  lines.push("", "Run the task anyway, and mention that the precheck needs fixing.");
  return { _tag: "error", section: lines.join("\n") };
}

export function withPrecheckSection(prompt: string, section: string): string {
  return `${prompt}\n\n---\n\n${section}`;
}

/**
 * Runs a task's precheck. Replaceable so tests do not spawn processes; the
 * default reports that nothing is configured, which surfaces as a failed
 * precheck rather than silently skipping it.
 */
export class ScheduledTaskPrecheckRunner extends Context.Reference<
  (request: PrecheckRequest) => Effect.Effect<PrecheckRaw>
>("t3/scheduledTasks/ScheduledTaskPrecheckRunner", {
  defaultValue: () => () =>
    Effect.succeed({ _tag: "failed", message: "This server has no precheck runner." }),
}) {}

const shellInvocation = (platform: NodeJS.Platform, command: string) =>
  platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
      }
    : { command: "/bin/sh", args: ["-c", command] };

export const layer = Layer.effect(
  ScheduledTaskPrecheckRunner,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const projects = yield* ProjectService.ProjectService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const platform = yield* HostProcess.Platform;

    const resolveCwd = Effect.fn("ScheduledTaskPrecheck.resolveCwd")(function* (
      request: PrecheckRequest,
    ) {
      if (request.threadId !== null) {
        const shell = yield* threads.getThreadShell(request.threadId);
        if (shell?.worktreePath != null) return shell.worktreePath;
      }
      const project = yield* projects.getById(request.projectId);
      return Option.isSome(project) ? project.value.workspaceRoot : null;
    });

    const run: (typeof ScheduledTaskPrecheckRunner)["Service"] = Effect.fn(
      "ScheduledTaskPrecheck.run",
    )(
      function* (request: PrecheckRequest): Effect.fn.Return<PrecheckRaw, unknown> {
        const cwd = yield* resolveCwd(request);
        if (cwd === null) {
          return { _tag: "failed", message: "The task's project folder was not found." };
        }
        const invocation = shellInvocation(platform, request.command);
        const output = yield* runner.run({
          ...invocation,
          cwd,
          // An open stdin would hang a command that waits for input.
          stdin: "",
          timeout: request.timeoutMs,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          maxOutputBytes: PRECHECK_COLLECT_LIMIT_BYTES,
        });
        return output.timedOut
          ? { _tag: "timedOut", timeoutMs: request.timeoutMs }
          : { _tag: "exited", code: output.code, stdout: output.stdout, stderr: output.stderr };
      },
      // A broken precheck must reach the model as text, so no failure escapes.
      Effect.catch((error) =>
        Effect.succeed<PrecheckRaw>({
          _tag: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.succeed<PrecheckRaw>({
          _tag: "failed",
          message: defect instanceof Error ? defect.message : String(defect),
        }),
      ),
    );
    return run;
  }),
);
