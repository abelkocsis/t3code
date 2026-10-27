/**
 * Reads and writes a provider's global instructions file, such as `~/.claude/CLAUDE.md`.
 *
 * The file lives in the provider's home directory, outside every workspace, so the project
 * file RPCs refuse it. This service resolves the path from the provider instance on its own;
 * a client names the instance, never a path, so it cannot reach any other file.
 *
 * @module AgentInstructionsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  AgentInstructionsError,
  agentInstructionsFileName,
  type AgentInstructionsGlobalFile,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerSettingsService } from "../serverSettings.ts";

export class AgentInstructionsService extends Context.Service<
  AgentInstructionsService,
  {
    readonly readGlobal: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<AgentInstructionsGlobalFile, AgentInstructionsError>;
    readonly writeGlobal: (
      instanceId: ProviderInstanceId,
      contents: string,
    ) => Effect.Effect<AgentInstructionsGlobalFile, AgentInstructionsError>;
  }
>()("t3/fork/AgentInstructionsService") {}

/** The instance's own home override, which both Claude and Codex instances call `homePath`. */
function instanceHomePath(config: unknown): string {
  if (typeof config !== "object" || config === null || !("homePath" in config)) return "";
  return typeof config.homePath === "string" ? config.homePath.trim() : "";
}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;

  // Mirrors where each provider looks: an instance override first, then the variable the CLI
  // honours, then its default home.
  const resolvePath = Effect.fn("AgentInstructionsService.resolvePath")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new AgentInstructionsError({
            reason: "readFailed",
            detail: "Server settings could not be read.",
            cause,
          }),
      ),
    );
    const instance = settings.providerInstances[instanceId];
    // A default instance carries its driver's name and may have no entry at all.
    const driver: string = instance?.driver ?? instanceId;
    const fileName = agentInstructionsFileName(driver);
    const homeVariable =
      driver === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : driver === "codex" ? "CODEX_HOME" : null;
    if (fileName === null || homeVariable === null) {
      return yield* new AgentInstructionsError({
        reason: "unsupportedProvider",
        detail: "This provider has no global instructions file T3 Code can edit.",
      });
    }
    const override = instanceHomePath(instance?.config);
    const inherited = environment[homeVariable]?.trim() ?? "";
    const directory =
      override.length > 0
        ? expandHomePath(override, home)
        : inherited.length > 0
          ? inherited
          : path.join(home, driver === "claudeAgent" ? ".claude" : ".codex");
    return path.resolve(directory, fileName);
  });

  const read = Effect.fn("AgentInstructionsService.read")(function* (filePath: string) {
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { path: filePath, contents: "", exists: false };
    const contents = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new AgentInstructionsError({
            reason: "readFailed",
            detail: "The instructions file could not be read.",
            cause,
          }),
      ),
    );
    return { path: filePath, contents, exists: true };
  });

  const readGlobal: AgentInstructionsService["Service"]["readGlobal"] = Effect.fn(
    "AgentInstructionsService.readGlobal",
  )(function* (instanceId) {
    return yield* read(yield* resolvePath(instanceId));
  });

  const writeGlobal: AgentInstructionsService["Service"]["writeGlobal"] = Effect.fn(
    "AgentInstructionsService.writeGlobal",
  )(function* (instanceId, contents) {
    const filePath = yield* resolvePath(instanceId);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new AgentInstructionsError({
            reason: "writeFailed",
            detail: "The instructions file could not be written.",
            cause,
          }),
      ),
    );
    return { path: filePath, contents, exists: true };
  });

  return AgentInstructionsService.of({ readGlobal, writeGlobal });
});

export const layer = Layer.effect(AgentInstructionsService, make);
