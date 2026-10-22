import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ThreadFolderId, ThreadId } from "@t3tools/contracts";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";

const layer = ForkThreadStateStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const folderX = ThreadFolderId.make("folder-x");

it.layer(layer)("ForkThreadStateStore", (it) => {
  it.effect("records the fork ledger apart from upstream's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const upstream = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE name LIKE 'Fork%'
      `;
      assert.deepStrictEqual(upstream, []);
      const fork = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM fork_sql_migrations ORDER BY migration_id
      `;
      assert.isAtLeast(fork.length, 2);
    }),
  );

  it.effect("sets and clears a folder, and streams the snapshot then each change", () =>
    Effect.gen(function* () {
      const store = yield* ForkThreadStateStore.ForkThreadStateStore;
      yield* store.setFolder(threadA, folderX);

      const collector = yield* store.subscribe.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      // Let the subscription attach before the writes it should observe.
      yield* Effect.yieldNow;
      yield* store.setFolder(threadB, folderX);
      const cleared = yield* store.setFolder(threadA, null);
      assert.strictEqual(cleared.folderId, null);

      const events = Array.from(yield* Fiber.join(collector));
      assert.strictEqual(events[0]?.type, "snapshot");
      if (events[0]?.type === "snapshot") {
        assert.deepStrictEqual(
          events[0].states.map((state) => [state.threadId, state.folderId]),
          [[threadA, folderX]],
        );
      }
      assert.deepStrictEqual(
        events.slice(1).map((event) => (event.type === "updated" ? event.state.folderId : "?")),
        [folderX, null],
      );

      const listed = yield* store.list;
      assert.deepStrictEqual(listed.map((state) => [state.threadId, state.folderId]).sort(), [
        [threadA, null],
        [threadB, folderX],
      ]);
    }),
  );
});
