import { assert, it } from "@effect/vitest";
import { ThreadFolderId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";
import { inheritThreadFolder } from "./ThreadFolderInheritance.ts";

const layer = ForkThreadStateStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
it.layer(layer)("ThreadFolderInheritance", (it) => {
  it.effect("copies the folder once and leaves later moves independent", () =>
    Effect.gen(function* () {
      const store = yield* ForkThreadStateStore.ForkThreadStateStore;
      const parent = ThreadId.make("parent");
      const child = ThreadId.make("child");
      const folder = ThreadFolderId.make("folder");
      const event = {
        type: "thread.created",
        threadId: child,
        payload: { lineage: { parentThreadId: parent, relationshipToParent: "fork" } },
      } as OrchestrationV2DomainEvent;
      yield* inheritThreadFolder(event);
      assert.isNull(yield* store.get(child));
      yield* store.setFolder(parent, folder);
      yield* inheritThreadFolder(event);
      assert.equal((yield* store.get(child))?.folderId, folder);
      assert.isNull((yield* store.get(child))?.factory);
      yield* store.setFolder(child, null);
      yield* inheritThreadFolder(event);
      assert.isNull((yield* store.get(child))?.folderId);
      yield* store.setFolder(parent, null);
      assert.isNull((yield* store.get(child))?.folderId);
    }),
  );
});
