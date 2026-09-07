import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderWorkspaceStateService from "./ProviderWorkspaceStateService.ts";
import { claudeProjectDirectoryName } from "./providerWorkspaceState.ts";

/**
 * Settings that name a config directory, through whichever of the two sources
 * the caller wants: the legacy per-driver block, or the instance map that is
 * replacing it.
 */
function settingsLayer(claudeHomePath: string, source: "legacy" | "instance" = "legacy") {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        // A disabled legacy block keeps the instance case honest: only the
        // instance may account for the link the test then expects.
        ...(source === "legacy" ? { homePath: claudeHomePath } : { enabled: false }),
      },
    },
    providerInstances:
      source === "instance"
        ? {
            ...DEFAULT_SERVER_SETTINGS.providerInstances,
            [ProviderInstanceId.make("claude-work")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeHomePath },
            },
          }
        : DEFAULT_SERVER_SETTINGS.providerInstances,
  };
  return Layer.mock(ServerSettings.ServerSettingsService)({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => Effect.succeed(settings),
    streamChanges: Stream.empty,
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
    source: "legacy" | "instance" = "legacy",
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-provider-state-" });
    const service = yield* ProviderWorkspaceStateService.make.pipe(
      Effect.provide(settingsLayer(configDir, source)),
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
