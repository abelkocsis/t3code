import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadFolderId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const RELEASE = ThreadFolderId.make("folder_release");

function makeReadModel(folderId: ThreadFolderId | null): OrchestrationReadModel {
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
        folderId,
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

const decide = (folderId: ThreadFolderId | null, current: ThreadFolderId | null) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.folder.set",
      commandId: CommandId.make("cmd-folder"),
      threadId: ThreadId.make("thread-1"),
      folderId,
    },
    readModel: makeReadModel(current),
  });

it.layer(NodeServices.layer)("thread.folder.set decider", (it) => {
  it.effect("moving a thread into a folder stamps the folder and updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(RELEASE, null));
      expect(event?.type).toBe("thread.folder-set");
      if (event?.type === "thread.folder-set") {
        expect(event.payload.folderId).toBe(RELEASE);
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("setting the folder it already has keeps updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(RELEASE, RELEASE));
      if (event?.type === "thread.folder-set") expect(event.payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("removing a thread from its folder clears the id", () =>
    Effect.gen(function* () {
      const [event] = events(yield* decide(null, RELEASE));
      if (event?.type === "thread.folder-set") {
        expect(event.payload.folderId).toBeNull();
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );
});
