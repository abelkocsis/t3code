import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderWorkspaceStateService from "./ProviderWorkspaceStateService.ts";
import { claudeProjectDirectoryName } from "./providerWorkspaceState.ts";

/**
 * Settings that name a config directory, either on the default Claude
 * instance or on a second one the user configured.
 */
function settingsLayer(claudeHomePath: string, source: "default" | "instance" = "default") {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances:
      source === "instance"
        ? {
            ...DEFAULT_SERVER_SETTINGS.providerInstances,
            // The default instance is turned off, so only the configured one
            // may account for the link the test then expects.
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [ProviderInstanceId.make("claude-work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeHomePath },
            },
          }
        : {
            ...DEFAULT_SERVER_SETTINGS.providerInstances,
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeHomePath },
            },
          },
  };
  return Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(settings),
  });
}

const PROJECT = "/tmp/t3-project";
const WORKTREE = "/tmp/t3-worktrees/fix-reconnect";

it.layer(NodeServices.layer)("provider workspace state", (it) => {
  /**
   * A config directory under a temp directory, plus the service pointed at it.
   * Nothing here touches the real provider config, which is the whole reason
   * the home path is set rather than defaulted.
   */
  const withService = Effect.fn("withService")(function* (
    source: "default" | "instance" = "default",
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-provider-state-" });
    const service = yield* ProviderWorkspaceStateService.make.pipe(
      Effect.provide(settingsLayer(configDir, source)),
      // A CLAUDE_CONFIG_DIR on the test machine must not leak in under the instance's own path.
      Effect.provideService(HostProcess.Environment, {}),
    );
    const projectDir = (absolutePath: string) =>
      path.join(configDir, "projects", claudeProjectDirectoryName(absolutePath));
    const memoryDir = (absolutePath: string) => path.join(projectDir(absolutePath), "memory");
    return { service, projectDir, memoryDir, fileSystem, path };
  });

  it.effect("links the worktree's memory at the project's, so both see one memory", () =>
    Effect.gen(function* () {
      const { service, memoryDir, fileSystem, path } = yield* withService();
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });
      yield* fileSystem.writeFileString(path.join(memoryDir(PROJECT), "MEMORY.md"), "- a fact");

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(memoryDir(WORKTREE), "MEMORY.md")),
        "- a fact",
      );
    }),
  );

  it.effect("shares the directory rather than copying it, so a new memory is not stranded", () =>
    Effect.gen(function* () {
      const { service, memoryDir, fileSystem, path } = yield* withService();
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      // Written from inside the worktree; the project must see it too.
      yield* fileSystem.writeFileString(
        path.join(memoryDir(WORKTREE), "learned.md"),
        "- learned in a worktree",
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(memoryDir(PROJECT), "learned.md")),
        "- learned in a worktree",
      );
    }),
  );

  it.effect("carries nothing for a project the provider has never seen", () =>
    Effect.gen(function* () {
      const { service, projectDir, fileSystem } = yield* withService();

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      assert.isFalse(yield* fileSystem.exists(projectDir(WORKTREE)));
    }),
  );

  it.effect("leaves a workspace that already has its own memory untouched", () =>
    Effect.gen(function* () {
      const { service, memoryDir, fileSystem, path } = yield* withService();
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(memoryDir(PROJECT), "MEMORY.md"),
        "- the project's",
      );
      yield* fileSystem.makeDirectory(memoryDir(WORKTREE), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(memoryDir(WORKTREE), "MEMORY.md"),
        "- the worktree's own",
      );

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(memoryDir(WORKTREE), "MEMORY.md")),
        "- the worktree's own",
      );
    }),
  );

  it.effect("does nothing when the thread runs in the project itself", () =>
    Effect.gen(function* () {
      const { service, memoryDir, fileSystem } = yield* withService();
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: PROJECT });

      // No self-link: the directory is still a plain directory.
      assert.strictEqual((yield* fileSystem.stat(memoryDir(PROJECT))).type, "Directory");
    }),
  );

  it.effect("finds the config directory through a configured instance too", () =>
    Effect.gen(function* () {
      const { service, memoryDir, fileSystem, path } = yield* withService("instance");
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });
      yield* fileSystem.writeFileString(path.join(memoryDir(PROJECT), "MEMORY.md"), "- a fact");

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(memoryDir(WORKTREE), "MEMORY.md")),
        "- a fact",
      );
    }),
  );

  it.effect("survives a config directory it cannot write into", () =>
    Effect.gen(function* () {
      const { service, projectDir, memoryDir, fileSystem } = yield* withService();
      yield* fileSystem.makeDirectory(memoryDir(PROJECT), { recursive: true });
      // A file sits where the worktree's project directory must go, so the
      // link cannot be made. A thread must still start.
      yield* fileSystem.writeFileString(projectDir(WORKTREE), "not a directory");

      yield* service.linkForWorktree({ projectPath: PROJECT, worktreePath: WORKTREE });

      assert.strictEqual(yield* fileSystem.readFileString(projectDir(WORKTREE)), "not a directory");
    }),
  );
});
