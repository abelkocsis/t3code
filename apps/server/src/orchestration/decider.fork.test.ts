import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const createdAt = "2026-09-15T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-source");
const forkThreadId = ThreadId.make("thread-fork");
const turnId = TurnId.make("turn-1");

function event(
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
  aggregateId: string = threadId,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: aggregateId === projectId ? "project" : "thread",
    aggregateId,
    type,
    occurredAt: createdAt,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${sequence}`),
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

const readModelWithCheckpoint = Effect.gen(function* () {
  let readModel: OrchestrationReadModel = createEmptyReadModel(createdAt);
  readModel = yield* projectEvent(
    readModel,
    event(
      1,
      "project.created",
      {
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
      projectId,
    ),
  );
  readModel = yield* projectEvent(
    readModel,
    event(2, "thread.created", {
      threadId,
      projectId,
      title: "Source thread",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    }),
  );
  readModel = yield* projectEvent(
    readModel,
    event(3, "thread.turn-diff-completed", {
      threadId,
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/source/turn/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-assistant"),
      completedAt: createdAt,
    }),
  );
  return readModel;
});

const forkCommand = {
  type: "thread.fork" as const,
  commandId: CommandId.make("command-fork"),
  threadId,
  forkThreadId,
  turnCount: 1,
  title: "Source thread (fork)",
  createdAt,
};

it.layer(NodeServices.layer)("thread fork", (it) => {
  it.effect("requests a fork for a turn that has a checkpoint", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithCheckpoint;

      const decided = yield* decideOrchestrationCommand({ command: forkCommand, readModel });

      expect(decided).toMatchObject({
        type: "thread.fork-requested",
        aggregateId: threadId,
        payload: {
          threadId,
          forkThreadId,
          turnCount: 1,
        },
      });
    }),
  );

  it.effect("rejects a fork at a turn the thread never checkpointed", () =>
    Effect.gen(function* () {
      const readModel = yield* readModelWithCheckpoint;

      const failure = yield* decideOrchestrationCommand({
        command: { ...forkCommand, turnCount: 7 },
        readModel,
      }).pipe(Effect.flip);

      expect(failure.message).toContain("no checkpoint for turn 7");
    }),
  );

  it.effect("rejects a fork into a thread id that already exists", () =>
    Effect.gen(function* () {
      let readModel = yield* readModelWithCheckpoint;
      readModel = yield* projectEvent(
        readModel,
        event(
          4,
          "thread.created",
          {
            threadId: forkThreadId,
            projectId,
            title: "Taken",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-opus-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
          forkThreadId,
        ),
      );

      const failure = yield* decideOrchestrationCommand({
        command: forkCommand,
        readModel,
      }).pipe(Effect.flip);

      expect(failure.message).toContain("cannot be created twice");
    }),
  );

  it.effect("hydrates a fork with the copied messages and activities", () =>
    Effect.gen(function* () {
      let readModel = yield* readModelWithCheckpoint;
      readModel = yield* projectEvent(
        readModel,
        event(
          4,
          "thread.created",
          {
            threadId: forkThreadId,
            projectId,
            title: "Fork",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-opus-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "t3code/abcd1234",
            worktreePath: "/tmp/project-fork",
            createdAt,
            updatedAt: createdAt,
          },
          forkThreadId,
        ),
      );

      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork.hydrate",
          commandId: CommandId.make("command-hydrate"),
          threadId: forkThreadId,
          sourceThreadId: threadId,
          turnCount: 1,
          messages: [
            {
              messageId: MessageId.make("message-user"),
              role: "user",
              text: "First prompt",
              turnId,
              createdAt,
            },
          ],
          activities: [
            {
              id: EventId.make("event-activity-copy"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Read a file",
              payload: { path: "README.md" },
              turnId,
              createdAt,
            },
          ],
          createdAt,
        },
        readModel,
      });

      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.message-sent",
        "thread.activity-appended",
        "thread.settled",
      ]);
      expect(events[1]).toMatchObject({
        payload: { activity: { kind: "tool.completed", summary: "Read a file" } },
      });
    }),
  );

  it.effect("refuses to hydrate a thread that already holds messages", () =>
    Effect.gen(function* () {
      let readModel = yield* readModelWithCheckpoint;
      readModel = yield* projectEvent(
        readModel,
        event(4, "thread.message-sent", {
          threadId,
          messageId: MessageId.make("message-user"),
          role: "user",
          text: "First prompt",
          turnId: null,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        }),
      );

      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork.hydrate",
          commandId: CommandId.make("command-hydrate"),
          threadId,
          sourceThreadId: threadId,
          turnCount: 1,
          messages: [
            {
              messageId: MessageId.make("message-copy"),
              role: "user",
              text: "First prompt",
              turnId: null,
              createdAt,
            },
          ],
          activities: [],
          createdAt,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(failure.message).toContain("must be active and empty");
    }),
  );
});
