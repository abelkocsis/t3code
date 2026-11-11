import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";

export const inheritThreadFolder = Effect.fn("ThreadFolderInheritance.inherit")(function* (
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "thread.created") return;
  const { lineage } = event.payload;
  if (lineage.relationshipToParent !== "fork" || lineage.parentThreadId === null) return;
  const store = yield* ForkThreadStateStore.ForkThreadStateStore;
  if ((yield* store.get(event.threadId)) !== null) return;
  const parent = yield* store.get(lineage.parentThreadId);
  if (parent?.folderId != null) yield* store.setFolder(event.threadId, parent.folderId);
});

export const start = Effect.fn("ThreadFolderInheritance.start")(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, (event) =>
      inheritThreadFolder(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not inherit the fork's folder", { cause }),
        ),
      ),
    ),
  );
});
