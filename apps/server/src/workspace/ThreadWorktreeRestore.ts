/**
 * ThreadWorktreeRestore - recreates a thread's managed worktree from its branch
 * when the folder is gone, so a terminal opened after storage cleanup starts in
 * the thread's workspace instead of failing on a missing cwd.
 *
 * @module ThreadWorktreeRestore
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    /** Never fails: a worktree that cannot be restored surfaces as the caller's missing cwd. */
    readonly restoreMissing: (threadId: string) => Effect.Effect<void>;
  }
>()("t3/workspace/ThreadWorktreeRestore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  // Terminals of one thread attach together; one git worktree add at a time.
  const semaphore = yield* Semaphore.make(1);

  const restoreMissing = Effect.fn("ThreadWorktreeRestore.restoreMissing")(function* (
    threadId: string,
  ) {
    const thread = yield* projections.getThreadShell(ThreadId.make(threadId));
    if (thread === null) return;
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    if (yield* fileSystem.exists(worktreePath)) return;
    // Recreated only where the server would have made it, as turn start does.
    if (!(yield* isManagedWorktreePath(worktreePath))) return;
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return;
    yield* Effect.logWarning("terminal open recreating missing worktree", {
      threadId,
      worktreePath,
      branch,
    });
    yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
    yield* gitWorkflow.createWorktree({
      cwd: project.value.workspaceRoot,
      refName: branch,
      path: worktreePath,
    });
  });

  return ThreadWorktreeRestore.of({
    restoreMissing: (threadId) =>
      semaphore
        .withPermits(1)(restoreMissing(threadId))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to recreate missing worktree", { threadId, error }),
          ),
        ),
  });
});

export const layer = Layer.effect(ThreadWorktreeRestore, make);
