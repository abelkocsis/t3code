import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ThreadFolderId, ThreadId, type ThreadFactory } from "@t3tools/contracts";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";

const layer = ForkThreadStateStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const folderX = ThreadFolderId.make("folder-x");
const factory: ThreadFactory = {
  input: { kind: "free-text", value: "Add a range cap" },
  phase: "implementation",
  summary: "Writing the code.",
  startedAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
};

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
      assert.isAtLeast(fork.length, 4);
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

  it.effect("sets and clears the factory state without touching the folder", () =>
    Effect.gen(function* () {
      const store = yield* ForkThreadStateStore.ForkThreadStateStore;
      const threadC = ThreadId.make("thread-c");
      yield* store.setFolder(threadC, folderX);
      const flagged = yield* store.setFactory(threadC, factory);
      assert.deepStrictEqual(flagged.factory, factory);
      assert.strictEqual(flagged.folderId, folderX);

      const listed = yield* store.list;
      assert.deepStrictEqual(listed.find((state) => state.threadId === threadC)?.factory, factory);

      const cleared = yield* store.setFactory(threadC, null);
      assert.strictEqual(cleared.factory, null);
      assert.strictEqual(cleared.folderId, folderX);
    }),
  );

  it.effect("reads a row whose factory JSON no longer decodes as a plain thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ForkThreadStateStore.ForkThreadStateStore;
      yield* sql`
        INSERT INTO fork_thread_state (thread_id, folder_id, factory_json, updated_at)
        VALUES ('thread-broken', NULL, '{"phase":"nowhere"}', '2026-10-14T10:00:00.000Z')
      `;
      const listed = yield* store.list;
      assert.strictEqual(listed.find((state) => state.threadId === "thread-broken")?.factory, null);
    }),
  );

  it.effect("links a Slack thread without touching the folder, and reads one row back", () =>
    Effect.gen(function* () {
      const store = yield* ForkThreadStateStore.ForkThreadStateStore;
      const threadC = ThreadId.make("thread-c");
      const slackThread = {
        url: "https://acme.slack.com/archives/C0123ABCD/p1700000000123456",
        channelId: "C0123ABCD",
        threadTs: "1700000000.123456",
      };
      yield* store.setFolder(threadC, folderX);
      const linked = yield* store.setSlackThread(threadC, slackThread);
      assert.deepStrictEqual(linked.slackThread, slackThread);
      assert.strictEqual(linked.folderId, folderX);

      const read = yield* store.get(threadC);
      assert.deepStrictEqual(read?.slackThread, slackThread);
      assert.strictEqual(yield* store.get(ThreadId.make("thread-unknown")), null);

      const unlinked = yield* store.setSlackThread(threadC, null);
      assert.strictEqual(unlinked.slackThread, null);
      assert.strictEqual(unlinked.folderId, folderX);
    }),
  );
});
