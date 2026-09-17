import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderWorkspaceStateService from "../../provider/ProviderWorkspaceStateService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { ThreadForkReactor, type ThreadForkReactorShape } from "../Services/ThreadForkReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Everything the source thread recorded up to and including the fork point. */
function sliceAtCheckpoint(input: {
  readonly thread: OrchestrationThread;
  readonly completedAt: string;
}): {
  readonly messages: OrchestrationThread["messages"];
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
} {
  const keeps = (createdAt: string) => compareDateTimeStrings(createdAt, input.completedAt) <= 0;
  return {
    messages: input.thread.messages.filter(
      (message) => message.role !== "system" && keeps(message.createdAt),
    ),
    activities: input.thread.activities.filter((activity) => keeps(activity.createdAt)),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const providerWorkspaceState = yield* ProviderWorkspaceStateService.ProviderWorkspaceStateService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const receiptBus = yield* RuntimeReceiptBus;

  const appendForkFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("thread-fork-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "thread.fork.failed",
            summary: "Fork failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const handleForkRequested = Effect.fn("handleForkRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.fork-requested" }>,
  ) {
    const { threadId, forkThreadId, turnCount, title } = event.payload;
    const now = yield* nowIso;

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return yield* appendForkFailureActivity({
        threadId,
        turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      });
    }

    const checkpoint = thread.checkpoints.find((entry) => entry.checkpointTurnCount === turnCount);
    if (!checkpoint) {
      return yield* appendForkFailureActivity({
        threadId,
        turnCount,
        detail: `Checkpoint for turn ${turnCount} is unavailable in read model.`,
        createdAt: now,
      });
    }

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!project) {
      return yield* appendForkFailureActivity({
        threadId,
        turnCount,
        detail: "Project was not found in read model.",
        createdAt: now,
      });
    }

    const projectCwd = project.workspaceRoot;
    if (!(yield* checkpointStore.isGitRepository(projectCwd))) {
      return yield* appendForkFailureActivity({
        threadId,
        turnCount,
        detail: "A fork needs a git repository, and this project is not one.",
        createdAt: now,
      });
    }

    // The provider binding comes first: a fork the provider cannot serve must
    // not leave a worktree and a thread behind.
    yield* providerService.prepareForkBinding({
      sourceThreadId: threadId,
      forkThreadId,
      turnId: checkpoint.turnId,
      turnCount,
    });

    // A checkpoint commit is parentless, so it can never be the worktree's
    // branch point. The fork branches from the source thread's branch and then
    // restores the checkpoint tree on top, which keeps real ancestry and makes
    // the fork's changes reviewable.
    const baseRef = thread.branch ?? "HEAD";
    const branchToken = yield* randomUUID;
    const forkBranch = buildTemporaryWorktreeBranchName(() => branchToken);
    const worktree = yield* gitWorkflow.createWorktree({
      cwd: projectCwd,
      refName: baseRef,
      newRefName: forkBranch,
      ...(thread.branch ? { baseRefName: thread.branch } : {}),
      path: null,
    });
    const worktreePath = worktree.worktree.path;

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: worktreePath,
      checkpointRef: checkpoint.checkpointRef,
      fallbackToHead: false,
    });
    if (!restored) {
      return yield* appendForkFailureActivity({
        threadId,
        turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${turnCount}.`,
        createdAt: now,
      });
    }

    yield* providerWorkspaceState.linkForWorktree({
      projectPath: projectCwd,
      worktreePath,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("thread-fork-create"),
      threadId: forkThreadId,
      projectId: thread.projectId,
      title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: worktree.worktree.refName,
      worktreePath,
      createdAt: now,
      historyImport: true,
    });

    const slice = sliceAtCheckpoint({ thread, completedAt: checkpoint.completedAt });
    if (slice.messages.length > 0) {
      const activities = yield* Effect.forEach(slice.activities, (activity) =>
        // The copies are new rows in the fork's own event log, so they cannot
        // reuse the source event ids.
        serverEventId.pipe(Effect.map((id) => ({ ...activity, id }))),
      );
      // A message id is unique across the environment, not inside a thread, so
      // a copy that reuses the source id moves the source's row into the fork
      // instead of duplicating it.
      const messages = yield* Effect.forEach(slice.messages, (message) =>
        randomUUID.pipe(
          Effect.map((uuid) => {
            const role = message.role === "assistant" ? ("assistant" as const) : ("user" as const);
            return {
              messageId: MessageId.make(role === "assistant" ? `assistant:${uuid}` : uuid),
              role,
              text: message.text,
              turnId: message.turnId,
              createdAt: message.createdAt,
            };
          }),
        ),
      );
      yield* orchestrationEngine.dispatch({
        type: "thread.fork.hydrate",
        commandId: yield* serverCommandId("thread-fork-hydrate"),
        threadId: forkThreadId,
        sourceThreadId: threadId,
        turnCount,
        messages,
        activities,
        createdAt: now,
      });
    }

    // A fresh worktree has no ignored files, so the fork needs the project's
    // setup script as much as any new worktree thread does.
    yield* setupScriptRunner
      .runForThread({
        threadId: forkThreadId,
        projectId: thread.projectId,
        projectCwd,
        worktreePath,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("fork setup script did not start", {
            threadId: forkThreadId,
            detail: error.message,
          }),
        ),
      );

    yield* receiptBus.publish({
      type: "thread.forked",
      threadId,
      forkThreadId,
      checkpointTurnCount: turnCount,
      worktreePath,
      createdAt: now,
    });
  });

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.fork-requested"
      ? handleForkRequested(event).pipe(
          Effect.catch((error) =>
            Effect.flatMap(nowIso, (createdAt) =>
              appendForkFailureActivity({
                threadId: event.payload.threadId,
                turnCount: event.payload.turnCount,
                detail: error.message,
                createdAt,
              }).pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        )
      : Effect.void;

  const processEventSafely = (event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread fork reactor failed to process an event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: ThreadForkReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.fork-requested" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadForkReactorShape;
});

export const ThreadForkReactorLive = Layer.effect(ThreadForkReactor, make);
