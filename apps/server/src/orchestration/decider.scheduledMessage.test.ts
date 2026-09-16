import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so a
// "future" due time is relative to 1970-01-01T00:00:00.000Z.
const FUTURE_DUE = "1970-01-02T09:00:00.000Z";
const PAST_DUE = "1969-12-31T09:00:00.000Z";

// Command read models carry no messages, so a finished turn is what marks a
// thread as started. See ProjectionSnapshotQuery.getCommandReadModel.
const LATEST_TURN = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
} as OrchestrationThread["latestTurn"];

function makeReadModel(input: {
  readonly scheduledMessage?: OrchestrationThread["scheduledMessage"];
  readonly latestTurn?: OrchestrationThread["latestTurn"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: input.latestTurn === undefined ? LATEST_TURN : input.latestTurn,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        scheduledMessage: input.scheduledMessage ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const scheduleCommand = (dueAt: string, messageId = "message-scheduled") =>
  ({
    type: "thread.message.schedule",
    commandId: CommandId.make("cmd-schedule"),
    threadId: ThreadId.make("thread-1"),
    message: { messageId: MessageId.make(messageId), text: "run the tests" },
    dueAt,
    createdAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("scheduled message decider", (it) => {
  it.effect("parks a message for a future time", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: scheduleCommand(FUTURE_DUE),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.message-scheduled");
      if (events[0]?.type === "thread.message-scheduled") {
        expect(events[0].payload.scheduledMessage.dueAt).toBe(FUTURE_DUE);
        expect(events[0].payload.scheduledMessage.text).toBe("run the tests");
      }
    }),
  );

  it.effect("rejects a due time that is not in the future", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: scheduleCommand(PAST_DUE),
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects scheduling on a thread that has never run a turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: scheduleCommand(FUTURE_DUE),
        readModel: makeReadModel({ latestTurn: null }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("cancels a parked message", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.unschedule",
          commandId: CommandId.make("cmd-unschedule"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          scheduledMessage: {
            messageId: MessageId.make("message-scheduled"),
            text: "run the tests",
            dueAt: FUTURE_DUE,
            scheduledAt: NOW,
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.message-unscheduled");
      if (events[0]?.type === "thread.message-unscheduled") {
        expect(events[0].payload.reason).toBe("user");
      }
    }),
  );

  it.effect("clears the schedule when the parked message starts its turn", () =>
    Effect.gen(function* () {
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-scheduled"),
            role: "user",
            text: "run the tests",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          scheduledMessage: {
            messageId: MessageId.make("message-scheduled"),
            text: "run the tests",
            dueAt: FUTURE_DUE,
            scheduledAt: NOW,
          },
        }),
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((entry) => entry.type)).toContain("thread.message-unscheduled");
    }),
  );

  it.effect("leaves the schedule alone when another message starts a turn", () =>
    Effect.gen(function* () {
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-other"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-typed"),
            role: "user",
            text: "something else",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          scheduledMessage: {
            messageId: MessageId.make("message-scheduled"),
            text: "run the tests",
            dueAt: FUTURE_DUE,
            scheduledAt: NOW,
          },
        }),
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((entry) => entry.type)).not.toContain("thread.message-unscheduled");
    }),
  );
});
