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

import { forkParked } from "../serverActivation.ts";
import { isScheduledMessageSendable } from "./ScheduledMessagePolicy.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Sends messages the user parked for a later time.
 *
 * The sweep is the whole timer: the server owns the schedule, so a message
 * fires with no client connected, and a restart resumes from the projection
 * rather than losing the parked message.
 */
export class ScheduledMessageReactor extends Context.Service<
  ScheduledMessageReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ScheduledMessageReactor") {}

/** Bounds how late a due message can be, against a sweep that costs one snapshot read. */
const SWEEP_INTERVAL = "30 seconds";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("ScheduledMessageReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const due = snapshot.threads.filter((thread) => isScheduledMessageSendable(thread, now));
    yield* Effect.forEach(
      due,
      (thread) =>
        Effect.gen(function* () {
          const scheduled = thread.scheduledMessage;
          if (scheduled == null) return;
          const uuid = yield* crypto.randomUUIDv4;
          // The turn keeps the scheduled messageId, which is how the decider
          // recognizes the parked message and clears the schedule in the same
          // decision. A later tick then finds nothing to send.
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:scheduled-message:${thread.id}:${uuid}`),
            threadId: thread.id,
            message: {
              messageId: MessageId.make(scheduled.messageId),
              role: "user",
              text: scheduled.text,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: now,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("scheduled message send skipped", {
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
        : Effect.logWarning("scheduled message sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const worker = yield* makeDrainableWorker(() => runSweep);

  const start: ScheduledMessageReactor["Service"]["start"] = Effect.fn(
    "ScheduledMessageReactor.start",
  )(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ScheduledMessageReactor["Service"];
});

export const layer = Layer.effect(ScheduledMessageReactor, make);
