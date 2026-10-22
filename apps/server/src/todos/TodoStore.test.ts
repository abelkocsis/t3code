import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TodoItem } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as TodoStore from "./TodoStore.ts";

const ITEM: TodoItem = { itemId: "todo-1", text: "Review PR#313", done: false };

/** Runs the body against a store rooted in a throwaway state directory. */
const withStore = <A, E>(
  body: Effect.Effect<
    A,
    E,
    TodoStore.TodoStore | ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-todos-" });
    return yield* body.pipe(
      Effect.provide(
        TodoStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("to-do store", (it) => {
  it.effect("reads an empty list before anything is written", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        assert.deepEqual((yield* store.read).items, []);
      }),
    ),
  );

  it.effect("keeps the order it was given", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        const second: TodoItem = { itemId: "todo-2", text: "Issue #341", done: false };
        yield* store.write([ITEM, second]);
        yield* store.write([second, ITEM]);
        assert.deepEqual(
          (yield* store.read).items.map((item) => item.itemId),
          ["todo-2", "todo-1"],
        );
      }),
    ),
  );

  it.effect("stamps the instant an item was added and the instant it was ticked off", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        yield* store.write([ITEM]);
        const open = (yield* store.read).items[0];
        assert.isString(open?.createdAt);
        assert.equal(open?.doneAt, undefined);

        yield* store.write([{ ...ITEM, done: true }]);
        const done = (yield* store.read).items[0];
        assert.equal(done?.createdAt, open?.createdAt);
        assert.isString(done?.doneAt);

        // A later write must not move the instant the user ticked the item off.
        yield* store.write([{ ...ITEM, text: "Review PR#314", done: true }]);
        assert.equal((yield* store.read).items[0]?.doneAt, done?.doneAt);
      }),
    ),
  );

  // The client sends the whole list on every change, so a wrong clock or a
  // replayed write must not decide which day the summary reports the item on.
  it.effect("ignores the timestamps the client sends", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        yield* store.write([
          {
            ...ITEM,
            done: true,
            createdAt: "1999-01-01T00:00:00.000Z",
            doneAt: "1999-01-01T00:00:00.000Z",
          },
        ]);
        const stored = (yield* store.read).items[0];
        assert.notEqual(stored?.createdAt, "1999-01-01T00:00:00.000Z");
        assert.notEqual(stored?.doneAt, "1999-01-01T00:00:00.000Z");
      }),
    ),
  );

  it.effect("reports a done item the user has already cleared", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        yield* store.write([{ ...ITEM, done: true }]);
        const doneAt = (yield* store.read).items[0]?.doneAt;
        yield* store.write([]);

        assert.deepEqual((yield* store.read).items, []);
        const completed = yield* store.readCompleted;
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.text, ITEM.text);
        assert.equal(completed[0]?.doneAt, doneAt);
      }),
    ),
  );

  it.effect("forgets a cleared item once it is older than the retention window", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const storePath = path.join(config.stateDir, "todos.json");
        const nowMs = yield* Clock.currentTimeMillis;
        const stale = DateTime.formatIso(
          DateTime.makeUnsafe(nowMs - TodoStore.ARCHIVE_RETENTION_MS - 60_000),
        );
        yield* fs.writeFileString(
          storePath,
          `{"version":2,"items":[],"archive":[{"itemId":"todo-old","text":"Last month","done":true,"doneAt":"${stale}"}],"updatedAt":"${stale}"}`,
        );

        assert.equal((yield* store.readCompleted).length, 1);
        yield* store.write([ITEM]);
        assert.deepEqual(yield* store.readCompleted, []);
      }),
    ),
  );

  // An open item the user deletes was never done, so nothing should keep it.
  it.effect("does not archive an item the user deleted while it was open", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        yield* store.write([ITEM]);
        yield* store.write([]);
        assert.deepEqual(yield* store.readCompleted, []);
      }),
    ),
  );

  // A corrupt file must not take the panel down with it: the user can still
  // type, and the next write repairs the file.
  it.effect("reads an unreadable file as an empty list", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* store.write([ITEM]);
        yield* fs.writeFileString(path.join(config.stateDir, "todos.json"), "{ not json");
        assert.deepEqual((yield* store.read).items, []);
        yield* store.write([ITEM]);
        const repaired = (yield* store.read).items;
        assert.equal(repaired.length, 1);
        assert.equal(repaired[0]?.text, ITEM.text);
      }),
    ),
  );
});
