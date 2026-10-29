import {
  CommandId,
  MessageId,
  parseFactoryPhaseMarker,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PullRequestChecksState,
  type ThreadFactory,
  type ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  decideFactoryReview,
  factoryPullRequestLink,
  factoryPullRequestView,
  type FactoryPullRequestView,
  watchedAfterReview,
} from "./FactoryReviewPolicy.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";

/**
 * Drives factory tasks: reads each phase marker the agent prints, moves a task through the
 * review stages from its pull request, and sends the agent review work.
 *
 * The pull request sync keeps the snapshot current; the host is read for reviews, open
 * threads and comments, which the snapshot does not carry, and only when the snapshot moved
 * or a quiet period passed. A sweep runs on every synced pull request, on every finished
 * run, and once a minute, so a message held back while the agent was busy goes out on the
 * next pass.
 */
export class FactoryReviewReactor extends Context.Service<
  FactoryReviewReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fork/FactoryReviewReactor") {}

const SWEEP_INTERVAL = "1 minute";
/** A task sleeping behind another pull request is checked this often. */
const BLOCKED_SWEEP_INTERVAL = "1 hour";
/** How long a host read stands in for a pull request whose snapshot did not move. */
const QUIET_REREAD_MS = 10 * 60_000;
/** The share of the context window at which a task compacts before new work. */
const COMPACT_AT = 0.8;

const REVIEW_STAGES: ReadonlySet<ThreadFactory["phase"]> = new Set([
  "done",
  "ready-for-review",
  "under-review",
  "ready-to-merge",
]);

const snapshotFingerprint = (snapshot: ThreadPullRequestSnapshot) =>
  [
    snapshot.state,
    snapshot.updatedAt,
    snapshot.checksState,
    snapshot.mergeability,
    snapshot.reviewDecision,
    snapshot.isDraft,
    snapshot.headBranch,
  ].join(" ");

/** The view when the host cannot be read: the snapshot alone, with the review fields unknown. */
function viewFromSnapshot(snapshot: ThreadPullRequestSnapshot): FactoryPullRequestView {
  return {
    state: snapshot.state,
    title: snapshot.title,
    baseBranch: snapshot.baseBranch,
    updatedAt: snapshot.updatedAt,
    checksState: (snapshot.checksState ?? null) as PullRequestChecksState | null,
    reviewDecision: snapshot.reviewDecision ?? null,
    mergeState:
      snapshot.mergeability === "conflicting"
        ? "dirty"
        : snapshot.mergeability === "mergeable"
          ? "clean"
          : snapshot.mergeability === undefined
            ? null
            : "unknown",
  };
}

const logSkipped =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const store = yield* ForkThreadStateStore.ForkThreadStateStore;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  // The tasks, kept current from the store stream, so an event needs no table read.
  const tasks = new Map<ThreadId, ThreadFactory>();
  const views = new Map<
    ThreadId,
    { readonly fingerprint: string; readonly at: number; readonly view: FactoryPullRequestView }
  >();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const setFactory = (threadId: ThreadId, factory: ThreadFactory | null) =>
    store.setFactory(threadId, factory).pipe(
      Effect.tap((state) =>
        Effect.sync(() => {
          if (state.factory === null) tasks.delete(threadId);
          else tasks.set(threadId, state.factory);
        }),
      ),
      Effect.asVoid,
    );

  /**
   * A task whose last turn filled most of its context compacts before new work, so the work
   * starts on a small context. The work queues behind the compaction; if that fails, the
   * queued message still goes out. Providers that report no usage are left alone.
   */
  const contextNearlyFull = (thread: OrchestrationV2ThreadShell) =>
    projections.getThreadRecords(thread.id, ["providerThreads"]).pipe(
      Effect.map((records) => {
        const active =
          records.providerThreads.find(
            (candidate) => candidate.id === thread.activeProviderThreadId,
          ) ?? records.providerThreads.at(-1);
        const usage = active?.contextUsage ?? null;
        if (usage === null || usage.maxTokens === undefined || usage.maxTokens <= 0) return false;
        return usage.usedTokens / usage.maxTokens >= COMPACT_AT;
      }),
      Effect.orElseSucceed(() => false),
    );

  const sendWork = Effect.fn("FactoryReviewReactor.sendWork")(function* (
    thread: OrchestrationV2ThreadShell,
    text: string,
  ) {
    if (yield* contextNearlyFull(thread)) {
      const compactId = yield* crypto.randomUUIDv4();
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:factory-compact:${thread.id}:${compactId}`),
          messageId: MessageId.make(`factory-compact:${thread.id}:${compactId}`),
          threadId: thread.id,
          text: "/compact",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(
          Effect.catchCause(
            logSkipped("factory compaction before new work skipped", { threadId: thread.id }),
          ),
        );
    }
    const uuid = yield* crypto.randomUUIDv4();
    yield* threadManagement.sendToThread({
      projectId: thread.projectId,
      commandId: CommandId.make(`server:factory-review-message:${thread.id}:${uuid}`),
      threadId: thread.id,
      messageId: MessageId.make(`factory-review:${thread.id}:${uuid}`),
      text,
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "server",
    });
  });

  /** The review view, from the host when the snapshot moved or the last read is old. */
  const readView = Effect.fn("FactoryReviewReactor.readView")(function* (
    thread: OrchestrationV2ThreadShell,
    link: ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot },
  ) {
    const fingerprint = snapshotFingerprint(link.snapshot);
    const now = yield* Clock.currentTimeMillis;
    const cached = views.get(thread.id);
    if (
      cached !== undefined &&
      cached.fingerprint === fingerprint &&
      now - cached.at < QUIET_REREAD_MS
    ) {
      return cached.view;
    }
    const reference = {
      projectId: thread.projectId,
      host: link.host,
      repository: link.repository,
      number: link.number,
      allowStale: true,
    };
    const detail = yield* pullRequests.detail(reference).pipe(Effect.option);
    if (detail._tag === "None") return viewFromSnapshot(link.snapshot);
    const activity = yield* pullRequests.activity(reference).pipe(Effect.orElseSucceed(() => null));
    const view = factoryPullRequestView(link.snapshot, detail.value, activity);
    views.set(thread.id, { fingerprint, at: now, view });
    return view;
  });

  const sweepThread = Effect.fn("FactoryReviewReactor.sweepThread")(function* (
    threadId: ThreadId,
    factory: ThreadFactory,
    tokenSaving: boolean,
    ignoreCi: boolean,
  ) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null) return;
    const link = factoryPullRequestLink(thread.pullRequests);
    if (link === null) return;
    // Phases the agent still owns need no sweep unless the pull request already ended.
    if (
      !REVIEW_STAGES.has(factory.phase) &&
      !watchedAfterReview(thread, factory) &&
      factory.pendingWork == null &&
      link.snapshot.state === "open"
    ) {
      return;
    }
    const view =
      link.snapshot.state === "open"
        ? yield* readView(thread, link)
        : viewFromSnapshot(link.snapshot);
    const decision = decideFactoryReview(
      { thread, factory, pullRequest: { link, view } },
      yield* nowIso,
      { tokenSaving, ignoreCi },
    );
    if (decision === null) return;
    if (decision.factory !== null) yield* setFactory(threadId, decision.factory);
    if (decision.message !== null) yield* sendWork(thread, decision.message);
  });

  const sweep = Effect.fn("FactoryReviewReactor.sweep")(function* (only: ThreadId | undefined) {
    const { factoryTokenSaving, factoryIgnoreCiEnabled, factoryIgnoreCi } =
      yield* settingsService.getSettings;
    const targets =
      only === undefined ? [...tasks] : [...tasks].filter(([threadId]) => threadId === only);
    yield* Effect.forEach(
      targets,
      ([threadId, factory]) =>
        sweepThread(
          threadId,
          factory,
          factoryTokenSaving,
          factoryIgnoreCiEnabled && factoryIgnoreCi,
        ).pipe(Effect.catchCause(logSkipped("factory review step skipped", { threadId }))),
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((only: ThreadId | undefined) =>
    sweep(only).pipe(Effect.catchCause(logSkipped("factory review sweep failed", {}))),
  );

  // Wakes every task that sleeps behind a pull request once that pull request merged.
  const wakeBlocked = Effect.fn("FactoryReviewReactor.wakeBlocked")(function* () {
    const blocked = [...tasks].filter(([, factory]) => factory.blockedBy != null);
    yield* Effect.forEach(
      blocked,
      ([threadId, factory]) =>
        Effect.gen(function* () {
          const blockedBy = factory.blockedBy!;
          const thread = yield* projections.getThreadShell(threadId);
          if (thread === null || thread.archivedAt !== null) return;
          const summary = yield* pullRequests.summary(
            {
              projectId: thread.projectId,
              host: blockedBy.host,
              repository: blockedBy.repository,
              number: blockedBy.number,
            },
            { recoverTransientFailure: false },
          );
          if (summary.state !== "merged") return;
          yield* setFactory(threadId, {
            ...factory,
            blockedBy: null,
            summary: `${blockedBy.repository}#${blockedBy.number} merged.`,
            updatedAt: yield* nowIso,
          });
          const wake = yield* crypto.randomUUIDv4();
          yield* engine.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`server:factory-unblock-wake:${threadId}:${wake}`),
            threadId,
            reason: "user",
          });
        }).pipe(Effect.catchCause(logSkipped("factory blocked check skipped", { threadId }))),
      { concurrency: 2, discard: true },
    );
  });

  /**
   * A factory task reports its phase with one marker line per assistant message. Only the
   * finished message is read, so a marker split across deltas still counts.
   */
  const recordPhaseMarker = Effect.fn("FactoryReviewReactor.recordPhaseMarker")(function* (
    threadId: ThreadId,
    text: string,
  ) {
    const factory = tasks.get(threadId);
    if (factory === undefined) return;
    const marker = parseFactoryPhaseMarker(text);
    if (marker === null) return;
    if (marker.phase === factory.phase && marker.summary === factory.summary) return;
    yield* setFactory(threadId, {
      ...factory,
      phase: marker.phase,
      summary: marker.summary,
      updatedAt: yield* nowIso,
      // The Factory page keeps the progress bar where the task stood before the gate.
      ...(marker.phase === "human-gate" && factory.phase !== "human-gate"
        ? { gatedFrom: factory.phase }
        : {}),
    });
  });

  // A wake from any source ends the wait on a blocking pull request.
  const recordWake = Effect.fn("FactoryReviewReactor.recordWake")(function* (threadId: ThreadId) {
    const factory = tasks.get(threadId);
    if (factory?.blockedBy == null) return;
    yield* setFactory(threadId, { ...factory, blockedBy: null });
  });

  const processEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    if (!tasks.has(event.threadId)) return Effect.void;
    switch (event.type) {
      case "turn-item.updated":
        return event.payload.type === "assistant_message" &&
          !event.payload.streaming &&
          event.payload.status === "completed"
          ? recordPhaseMarker(event.threadId, event.payload.text).pipe(
              Effect.catchCause(
                logSkipped("factory phase marker skipped", { threadId: event.threadId }),
              ),
            )
          : Effect.void;
      case "thread.unsnoozed":
        return recordWake(event.threadId).pipe(
          Effect.catchCause(logSkipped("factory wake skipped", { threadId: event.threadId })),
        );
      case "thread.pull-request-synced":
      case "thread.pull-request-link-updated":
        return worker.enqueue(event.threadId);
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? worker.enqueue(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: FactoryReviewReactor["Service"]["start"] = Effect.fn("FactoryReviewReactor.start")(
    function* () {
      // The store stream opens with the whole table, so the task map is full before the
      // first sweep; later rows replace the task they name.
      yield* forkParked(
        Stream.runForEach(store.subscribe, (change) =>
          Effect.sync(() => {
            if (change.type === "snapshot") {
              tasks.clear();
              for (const state of change.states) {
                if (state.factory !== null) tasks.set(state.threadId, state.factory);
              }
              return;
            }
            if (change.state.factory === null) tasks.delete(change.state.threadId);
            else tasks.set(change.state.threadId, change.state.factory);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("factory task stream failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, processEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("factory review event stream failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
      yield* forkParked(
        wakeBlocked().pipe(
          Effect.catchCause(logSkipped("factory blocked sweep failed", {})),
          Effect.repeat(Schedule.spaced(BLOCKED_SWEEP_INTERVAL)),
          Effect.asVoid,
        ),
      );
    },
  );

  return { start, drain: worker.drain } satisfies FactoryReviewReactor["Service"];
});

export const layer = Layer.effect(FactoryReviewReactor, make);
