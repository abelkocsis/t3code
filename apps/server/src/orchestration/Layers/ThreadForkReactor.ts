import {
  CommandId,
  PROVIDER_SWITCH_DRIVER_KINDS,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
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
import {
  buildHandoffPrefix,
  buildHandoffTranscript,
  makeHandoffStore,
} from "../providerSwitchHandoff.ts";
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
  const handoffStore = yield* makeHandoffStore;

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

  /** Copies of a history slice, with fresh ids, for a hydrate command. */
  const copyHistory = Effect.fn("copyHistory")(function* (slice: {
    readonly messages: OrchestrationThread["messages"];
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }) {
    const activities = yield* Effect.forEach(slice.activities, (activity) =>
      // The copies are new rows in the target's own event log, so they cannot
      // reuse the source event ids.
      serverEventId.pipe(Effect.map((id) => ({ ...activity, id }))),
    );
    // A message id is unique across the environment, not inside a thread, so
    // a copy that reuses the source id moves the source's row into the target
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
    return { messages, activities };
  });

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
      const { messages, activities } = yield* copyHistory(slice);
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

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: OrchestrationThreadActivity["tone"];
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("thread-provider-switch-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendSwitchFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    appendActivity({
      threadId: input.threadId,
      tone: "error",
      kind: "thread.provider-switch.failed",
      summary: "Provider switch failed",
      payload: { detail: input.detail },
      createdAt: input.createdAt,
    });

  const providerLabel = (info: {
    readonly displayName: string | undefined;
    readonly driverKind: string;
  }) =>
    info.displayName ??
    (info.driverKind === "claudeAgent"
      ? "Claude"
      : info.driverKind === "codex"
        ? "Codex"
        : info.driverKind);

  const handleProviderSwitchRequested = Effect.fn("handleProviderSwitchRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.provider-switch-requested" }>,
  ) {
    const { threadId, newThreadId, modelSelection, title, settleSource } = event.payload;
    const now = yield* nowIso;

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return yield* appendSwitchFailureActivity({
        threadId,
        detail: "Thread was not found in read model.",
        createdAt: now,
      });
    }
    const sourceInfo = yield* providerService.getInstanceInfo(thread.modelSelection.instanceId);
    const targetInfo = yield* providerService.getInstanceInfo(modelSelection.instanceId);
    if (
      !PROVIDER_SWITCH_DRIVER_KINDS.includes(sourceInfo.driverKind) ||
      !PROVIDER_SWITCH_DRIVER_KINDS.includes(targetInfo.driverKind)
    ) {
      return yield* appendSwitchFailureActivity({
        threadId,
        detail: "A provider switch supports Claude and Codex only.",
        createdAt: now,
      });
    }
    const sourceProvider = providerLabel(sourceInfo);
    const targetProvider = providerLabel(targetInfo);

    const history = {
      messages: thread.messages.filter((message) => message.role !== "system"),
      activities: thread.activities,
    };
    const transcriptPath = yield* handoffStore.write({
      threadId: newThreadId,
      transcript: buildHandoffTranscript({
        title: thread.title,
        sourceProvider,
        messages: history.messages,
        activities: history.activities,
      }),
      prefix: (path) =>
        buildHandoffPrefix({ sourceProvider, transcriptPath: path, messages: history.messages }),
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("thread-provider-switch-create"),
      threadId: newThreadId,
      projectId: thread.projectId,
      title,
      modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      createdAt: now,
      historyImport: true,
    });

    const scheduledMessage = thread.scheduledMessage ?? undefined;
    if (history.messages.length > 0) {
      const copies = yield* copyHistory(history);
      yield* orchestrationEngine.dispatch({
        type: "thread.fork.hydrate",
        commandId: yield* serverCommandId("thread-provider-switch-hydrate"),
        threadId: newThreadId,
        sourceThreadId: threadId,
        turnCount: Math.max(1, thread.checkpoints.length),
        messages: copies.messages,
        activities: copies.activities,
        ...(scheduledMessage !== undefined ? { scheduledMessage } : {}),
        createdAt: now,
      });
    }

    yield* appendActivity({
      threadId: newThreadId,
      tone: "info",
      kind: "thread.provider-switch.continued-from",
      summary: `Continued from ${sourceProvider}`,
      payload: { threadId, title: thread.title, provider: sourceProvider, transcriptPath },
      createdAt: now,
    });
    yield* appendActivity({
      threadId,
      tone: "info",
      kind: "thread.provider-switch.continued-in",
      summary: `Continued in ${targetProvider}`,
      payload: { threadId: newThreadId, title, provider: targetProvider },
      createdAt: now,
    });

    // The new thread takes over everything that points at the task. Each move
    // is best effort: the new thread exists by now, and one failed link must
    // not hide it.
    const dispatchTagged = (tag: string, command: (commandId: CommandId) => OrchestrationCommand) =>
      serverCommandId(`thread-provider-switch-${tag}`).pipe(
        Effect.flatMap((commandId) => orchestrationEngine.dispatch(command(commandId))),
        Effect.asVoid,
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider switch step failed", {
              step: tag,
              threadId,
              newThreadId,
              cause: Cause.pretty(cause),
            }),
        ),
      );

    if (thread.folderId) {
      const folderId = thread.folderId;
      yield* dispatchTagged("folder", (commandId) => ({
        type: "thread.folder.set",
        commandId,
        threadId: newThreadId,
        folderId,
      }));
    }
    if (thread.slackThread) {
      const slackThread = thread.slackThread;
      yield* dispatchTagged("slack", (commandId) => ({
        type: "thread.slack-thread.set",
        commandId,
        threadId: newThreadId,
        slackThread,
      }));
    }
    for (const link of thread.pullRequests) {
      yield* dispatchTagged("pull-request", (commandId) => ({
        type: "thread.pull-request.link",
        commandId,
        threadId: newThreadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        source: link.source,
      }));
    }
    if (thread.snoozedUntil && compareDateTimeStrings(thread.snoozedUntil, now) > 0) {
      const snoozedUntil = thread.snoozedUntil;
      yield* dispatchTagged("snooze", (commandId) => ({
        type: "thread.snooze",
        commandId,
        threadId: newThreadId,
        snoozedUntil,
      }));
    }
    if (thread.factory) {
      const factory = thread.factory;
      yield* dispatchTagged("factory", (commandId) => ({
        type: "thread.factory.set",
        commandId,
        threadId: newThreadId,
        factory,
      }));
      yield* dispatchTagged("factory-clear", (commandId) => ({
        type: "thread.factory.set",
        commandId,
        threadId,
        factory: null,
      }));
    }
    if (scheduledMessage !== undefined && history.messages.length > 0) {
      yield* dispatchTagged("unschedule", (commandId) => ({
        type: "thread.message.unschedule",
        commandId,
        threadId,
      }));
    }

    if (settleSource) {
      yield* dispatchTagged("settle", (commandId) => ({
        type: "thread.settle",
        commandId,
        threadId,
      }));
    } else {
      const messageId = MessageId.make(yield* randomUUID);
      yield* dispatchTagged("check-in", (commandId) => ({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: `A ${targetProvider} session now continues this task in a new thread, "${title}", in the same worktree. Before you do any more work in this thread, check in with the user and look at what that session changed.`,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
      }));
    }

    yield* receiptBus.publish({
      type: "thread.provider-switched",
      threadId,
      newThreadId,
      createdAt: now,
    });
  });

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.provider-switch-requested"
      ? handleProviderSwitchRequested(event).pipe(
          Effect.catch((error) =>
            Effect.flatMap(nowIso, (createdAt) =>
              appendSwitchFailureActivity({
                threadId: event.payload.threadId,
                detail: error.message,
                createdAt,
              }).pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        )
      : event.type === "thread.fork-requested"
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
        event.type === "thread.fork-requested" || event.type === "thread.provider-switch-requested"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadForkReactorShape;
});

export const ThreadForkReactorLive = Layer.effect(ThreadForkReactor, make);
