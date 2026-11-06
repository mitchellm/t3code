/**
 * Fork: the MCP servers a judge or delegated Claude child starts. `strictMcpConfig` is the only
 * SDK switch that leaves hooks, permissions and skills alone (`settingSources` would drop them
 * with the MCP config), so a strict session starts only what `mcpServers` names and this module
 * spells out what a child gets beside T3's own server.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

type McpServers = Record<string, McpServerConfig>;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Entries are Claude's own config, passed back to it unchanged.
const serversOf = (value: unknown): McpServers =>
  isRecord(value) && isRecord(value.mcpServers) ? (value.mcpServers as McpServers) : {};

/** Where Claude Code keeps user-level config: inside the config dir when one is set, else the home directory. */
export const claudeGlobalConfigFile = (input: {
  readonly path: Path.Path;
  readonly configDir: string;
  readonly homeDirectory: string;
  readonly configDirIsExplicit: boolean;
}) =>
  input.configDirIsExplicit
    ? input.path.join(input.configDir, ".claude.json")
    : input.path.join(input.homeDirectory, ".claude.json");

const directoryAndAncestors = (path: Path.Path, directory: string) => {
  const directories: Array<string> = [];
  for (let current = path.resolve(directory); ;) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
};

/** The servers a strict session adds to T3's own: none for a judge. */
export const claudeScopedMcpServers = Effect.fn("ClaudeScopedMcp.servers")(function* (input: {
  readonly scope: ProviderAdapter.ProviderAdapterV2McpScope;
  readonly cwd: string | null;
  readonly globalConfigFile: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  if (input.scope.kind === "judge") return {} satisfies McpServers;

  const readJson = (file: string) =>
    input.fileSystem.readFileString(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read an MCP config for a delegated Claude session.", {
          file,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  // Claude merges .mcp.json files from the working directory up, nearest winning.
  const directories = input.cwd === null ? [] : directoryAndAncestors(input.path, input.cwd);
  const projectConfigs = yield* Effect.forEach(
    directories,
    (directory) => readJson(input.path.join(directory, ".mcp.json")),
    { concurrency: "unbounded" },
  );
  const projectServers: McpServers = Object.assign(
    {},
    ...projectConfigs.toReversed().map(serversOf),
  );

  if (input.scope.userServers.length === 0) return projectServers;

  const globalConfig = yield* readJson(input.globalConfigFile);
  const projects =
    isRecord(globalConfig) && isRecord(globalConfig.projects) ? globalConfig.projects : {};
  // Local scope is keyed by the project path with forward slashes.
  const localKey = directories
    .map((directory) => directory.replaceAll("\\", "/"))
    .find((key) => key in projects);
  const configured: McpServers = {
    ...serversOf(globalConfig),
    ...(localKey === undefined ? {} : serversOf(projects[localKey])),
  };
  const listed = Object.fromEntries(
    input.scope.userServers.flatMap((name) =>
      Object.hasOwn(configured, name) ? [[name, configured[name]!] as const] : [],
    ),
  );
  // A project server keeps its name over a listed user-level one.
  return { ...listed, ...projectServers };
});
