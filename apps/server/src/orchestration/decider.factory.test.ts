import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadFactory,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const TASK: ThreadFactory = {
  input: { kind: "github-issue", value: "https://github.com/acme/app/issues/1" },
  phase: "requirements",
  summary: null,
  startedAt: NOW,
  updatedAt: NOW,
};

function makeReadModel(factory: ThreadFactory | null): OrchestrationReadModel {
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
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        factory,
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

const events = (event: Effect.Success<ReturnType<typeof decideOrchestrationCommand>>) =>
  Array.isArray(event) ? event : [event];

const decide = (factory: ThreadFactory | null, current: ThreadFactory | null) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.factory.set",
      commandId: CommandId.make("cmd-factory"),
      threadId: ThreadId.make("thread-1"),
      factory,
    },
    readModel: makeReadModel(current),
  });

it.layer(NodeServices.layer)("thread.factory.set decider", (it) => {
  it.effect("starting a task stores it and moves updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(TASK, null));
      expect(event?.type).toBe("thread.factory-set");
      if (event?.type === "thread.factory-set") {
        expect(event.payload.factory).toEqual(TASK);
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("a phase change moves updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decide({ ...TASK, phase: "review", summary: "Reviewers read the diff." }, TASK),
      );
      if (event?.type === "thread.factory-set") {
        expect(event.payload.factory?.phase).toBe("review");
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("the same phase and summary again keeps updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decide({ ...TASK, updatedAt: "2026-02-01T00:00:00.000Z" }, TASK),
      );
      if (event?.type === "thread.factory-set") expect(event.payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("clearing takes the thread off the factory", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(null, TASK));
      if (event?.type === "thread.factory-set") {
        expect(event.payload.factory).toBeNull();
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );
});
