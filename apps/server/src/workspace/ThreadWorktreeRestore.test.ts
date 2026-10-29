import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorktreeRestore from "./ThreadWorktreeRestore.ts";

it.effect.each([
  { name: "a missing managed worktree", place: "worktrees", exists: false, recreated: true },
  { name: "an existing worktree", place: "worktrees", exists: true, recreated: false },
  // A path the server would not have made is left missing, not recreated.
  { name: "a missing unmanaged path", place: "elsewhere", exists: false, recreated: false },
])("restores $name only when the server made it", ({ place, exists, recreated }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-worktree-restore-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = path.join(workspaceRoot, place, "repo", "feature");
    if (exists) yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const threadId = ThreadId.make("thread-worktree-restore");
    const projectId = ProjectId.make("project-worktree-restore");
    const branch = "feature/restore";
    const calls: string[] = [];

    const layer = ThreadWorktreeRestore.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) => {
              assert.equal(id, threadId);
              return Effect.succeed({ projectId, worktreePath, branch } as never);
            },
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeed(Option.some({ workspaceRoot } as never));
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            createWorktree: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                return {} as never;
              }),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const restore = yield* ThreadWorktreeRestore.ThreadWorktreeRestore;
      yield* restore.restoreMissing(threadId);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(calls, recreated ? ["prune", "create"] : []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
