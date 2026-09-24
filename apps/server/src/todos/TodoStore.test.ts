import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { TodoItem } from "@t3tools/contracts";
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

  it.effect("keeps a done item and the time it was ticked off", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* TodoStore.TodoStore;
        yield* store.write([{ ...ITEM, done: true, doneAt: "2026-09-24T09:00:00.000Z" }]);
        const stored = (yield* store.read).items[0];
        assert.equal(stored?.done, true);
        assert.equal(stored?.doneAt, "2026-09-24T09:00:00.000Z");
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
        assert.deepEqual((yield* store.read).items, [ITEM]);
      }),
    ),
  );
});
