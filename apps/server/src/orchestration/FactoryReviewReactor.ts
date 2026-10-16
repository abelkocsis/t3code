import { CommandId, MessageId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { decideFactoryReview } from "./FactoryReviewPolicy.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Drives factory tasks through the review stages from their pull requests.
 *
 * The pull request sync already polls the host; this reads what it stored. A sweep runs on
 * every synced pull request and once a minute, so a message held back while the agent was
 * busy goes out on the next pass.
 */
export class FactoryReviewReactor extends Context.Service<
  FactoryReviewReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FactoryReviewReactor") {}

const SWEEP_INTERVAL = "1 minute";
/** A task sleeping behind another pull request is checked this often. */
const BLOCKED_SWEEP_INTERVAL = "1 hour";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  // Wakes every task that sleeps behind a pull request once that pull request merged.
  const wakeBlocked = Effect.fn("FactoryReviewReactor.wakeBlocked")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const blocked = snapshot.threads.filter(
      (thread) => thread.archivedAt === null && thread.factory?.blockedBy != null,
    );
    yield* Effect.forEach(
      blocked,
      (thread) =>
        Effect.gen(function* () {
          const factory = thread.factory!;
          const blockedBy = factory.blockedBy!;
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
          const uuid = yield* crypto.randomUUIDv4;
          yield* engine.dispatch({
            type: "thread.factory.set",
            commandId: CommandId.make(`server:factory-unblock:${thread.id}:${uuid}`),
            threadId: thread.id,
            factory: {
              ...factory,
              blockedBy: null,
              summary: `${blockedBy.repository}#${blockedBy.number} merged.`,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
          });
          const wake = yield* crypto.randomUUIDv4;
          yield* engine.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`server:factory-unblock-wake:${thread.id}:${wake}`),
            threadId: thread.id,
            reason: "user",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("factory blocked check skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  });

  const sweep = Effect.fn("FactoryReviewReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const { factoryTokenSaving } = yield* settingsService.getSettings;
    yield* Effect.forEach(
      snapshot.threads,
      (thread) =>
        Effect.gen(function* () {
          const decision = decideFactoryReview(thread, now, { tokenSaving: factoryTokenSaving });
          if (decision === null) return;
          if (decision.factory !== null) {
            const uuid = yield* crypto.randomUUIDv4;
            yield* engine.dispatch({
              type: "thread.factory.set",
              commandId: CommandId.make(`server:factory-review:${thread.id}:${uuid}`),
              threadId: thread.id,
              factory: decision.factory,
            });
          }
          if (decision.message !== null) {
            const uuid = yield* crypto.randomUUIDv4;
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`server:factory-review-message:${thread.id}:${uuid}`),
              threadId: thread.id,
              message: {
                messageId: MessageId.make(uuid),
                role: "user",
                text: decision.message,
                attachments: [],
              },
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: now,
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("factory review step skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("factory review sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const worker = yield* makeDrainableWorker(() => runSweep);

  const start: FactoryReviewReactor["Service"]["start"] = Effect.fn("FactoryReviewReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) =>
          event.type === "thread.pull-request-synced" ? worker.enqueue(undefined) : Effect.void,
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
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("factory blocked sweep failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.repeat(Schedule.spaced(BLOCKED_SWEEP_INTERVAL)),
          Effect.asVoid,
        ),
      );
    },
  );

  return { start, drain: worker.drain } satisfies FactoryReviewReactor["Service"];
});

export const layer = Layer.effect(FactoryReviewReactor, make);
