import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type SlackThreadRef,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const REVIEW: SlackThreadRef = {
  url: "https://acme.slack.com/archives/C01/p1700000000123456",
  channelId: "C01",
  threadTs: "1700000000.123456",
};

function makeReadModel(slackThread: SlackThreadRef | null): OrchestrationReadModel {
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
        slackThread,
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

const decide = (slackThread: SlackThreadRef | null, current: SlackThreadRef | null) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.slack-thread.set",
      commandId: CommandId.make("cmd-slack"),
      threadId: ThreadId.make("thread-1"),
      slackThread,
    },
    readModel: makeReadModel(current),
  });

it.layer(NodeServices.layer)("thread.slack-thread.set decider", (it) => {
  it.effect("linking a Slack thread stores it and moves updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(REVIEW, null));
      expect(event?.type).toBe("thread.slack-thread-set");
      if (event?.type === "thread.slack-thread-set") {
        expect(event.payload.slackThread).toEqual(REVIEW);
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("relinking the same message keeps updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide({ ...REVIEW, url: `${REVIEW.url}?cid=C01` }, REVIEW));
      if (event?.type === "thread.slack-thread-set") expect(event.payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("unlinking clears the Slack thread", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(null, REVIEW));
      if (event?.type === "thread.slack-thread-set") {
        expect(event.payload.slackThread).toBeNull();
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );
});
