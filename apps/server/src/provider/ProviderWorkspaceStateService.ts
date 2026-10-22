// @effect-diagnostics nodeBuiltinImport:off -- Node's typed junction API links a directory on Windows without symlink privileges.
import * as NodeFSP from "node:fs/promises";

import {
  ClaudeSettings,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { workspaceStateLinks, type WorkspaceStateLink } from "./providerWorkspaceState.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * Carries a provider's project-scoped state into a new workspace.
 *
 * A worktree is a new path, and a provider that files its project state under
 * that path starts empty there: the memory a user built up over a repository
 * disappears the moment work moves into a fresh workspace. This links the new
 * path's directory at the old one so the two share it, rather than copying,
 * which would fork the memory again on the first write.
 *
 * Best-effort throughout. There is nothing here a user asked for directly, and
 * a thread that starts without its memory is worse off but still working, so
 * every failure is a warning in the log.
 */
export class ProviderWorkspaceStateService extends Context.Service<
  ProviderWorkspaceStateService,
  {
    readonly linkForWorktree: (input: {
      readonly projectPath: string;
      readonly worktreePath: string;
    }) => Effect.Effect<void>;
  }
>()("t3/provider/ProviderWorkspaceStateService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  // Windows refuses a directory symlink without elevation, so link a junction
  // there instead; both make the two paths read as one directory.
  const linkType = (yield* HostProcess.isWindows) ? "junction" : "dir";

  /**
   * Every enabled Claude instance, as the config directory its CLI would read.
   * The same precedence as the driver: the instance's own `homePath`, then a
   * `CLAUDE_CONFIG_DIR` already in the environment, then `~/.claude`.
   */
  const claudeConfigDirs = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const configDirs = new Set<string>();
    for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
      if (instance.driver !== "claudeAgent" || !resolveProviderInstanceEnabled(instance)) continue;
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      configDirs.add(
        yield* resolveClaudeHomePath(config.value, environment).pipe(
          Effect.provideService(Path.Path, path),
        ),
      );
    }
    return [...configDirs];
  });

  /**
   * Link one directory, leaving anything already there untouched. A workspace
   * that has built up its own state must never lose it to this.
   */
  const linkOne = Effect.fn("ProviderWorkspaceStateService.linkOne")(
    function* (input: { readonly configDir: string; readonly link: WorkspaceStateLink }) {
      const source = path.join(input.configDir, ...input.link.sourceSegments);
      const destination = path.join(input.configDir, ...input.link.destinationSegments);
      // Nothing carried over for a project the provider has never seen.
      if (!(yield* fileSystem.exists(source))) return;
      if (yield* fileSystem.exists(destination)) return;
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* Effect.tryPromise(() => NodeFSP.symlink(source, destination, linkType));
      yield* Effect.logDebug("carried provider state into a new workspace", {
        driver: input.link.driver,
        state: input.link.label,
        source,
        destination,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not carry provider state into a new workspace", {
            driver: input.link.driver,
            state: input.link.label,
            error,
          }),
        ),
      ),
  );

  const linkForWorktree = Effect.fn("ProviderWorkspaceStateService.linkForWorktree")(
    function* (input: { readonly projectPath: string; readonly worktreePath: string }) {
      for (const configDir of yield* claudeConfigDirs) {
        const links = workspaceStateLinks({
          driver: ProviderDriverKind.make("claudeAgent"),
          projectPath: input.projectPath,
          worktreePath: input.worktreePath,
        });
        for (const link of links) {
          yield* linkOne({ configDir, link });
        }
      }
    },
  );

  return ProviderWorkspaceStateService.of({
    linkForWorktree: (input) =>
      linkForWorktree(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider workspace state was not carried over", {
            worktreePath: input.worktreePath,
            cause,
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(ProviderWorkspaceStateService, make);
