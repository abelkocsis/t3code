/**
 * Keeps the environment's to-do list on disk, in one JSON file.
 *
 * The list is typed by the user, derives from nothing, and no decider reasons
 * about it, so it stays out of the orchestration event stream. It sits beside
 * the standup summaries for the same reason they do.
 *
 * Unlike a summary, a to-do is not recoverable from anything else. A failed
 * write is therefore reported to the client rather than swallowed.
 *
 * @module TodoStore
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { TodoError, TodoItem, type TodoList } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * How many items the file keeps.
 *
 * A hand-typed list never reaches this. The cap is there so a client bug
 * cannot grow the file without bound.
 */
export const MAX_TODO_ITEMS = 500;

const CURRENT_VERSION = 1;

const TodoDocument = Schema.Struct({
  version: Schema.Number,
  items: Schema.Array(TodoItem),
  updatedAt: Schema.String,
});

export class TodoStore extends Context.Service<
  TodoStore,
  {
    readonly read: Effect.Effect<TodoList, TodoError>;
    /** Replaces the list and answers with what was stored. */
    readonly write: (items: ReadonlyArray<TodoItem>) => Effect.Effect<TodoList, TodoError>;
  }
>()("t3/todos/TodoStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(TodoDocument));
  const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(TodoDocument));
  const storePath = path.join(config.stateDir, "todos.json");

  /**
   * A missing file is an empty list: the first read happens before the first
   * write. An unreadable one is also empty rather than an error, so a corrupt
   * file leaves the panel usable and the next write repairs it.
   */
  const read: Effect.Effect<TodoList, TodoError> = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(storePath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return { items: [], updatedAt: DateTime.formatIso(yield* DateTime.now) };
    const document = yield* decodeDocument(raw).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (document === null) return { items: [], updatedAt: DateTime.formatIso(yield* DateTime.now) };
    return { items: document.items, updatedAt: document.updatedAt };
  });

  const write = (items: ReadonlyArray<TodoItem>) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const trimmed = items.slice(0, MAX_TODO_ITEMS);
      const encoded = yield* encodeDocument({
        version: CURRENT_VERSION,
        items: trimmed,
        updatedAt,
      }).pipe(
        Effect.catchCause(
          (cause) =>
            new TodoError({
              reason: "writeFailed",
              detail: "The to-do list could not be encoded.",
              cause,
            }),
        ),
      );
      yield* writeFileStringAtomically({ filePath: storePath, contents: `${encoded}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause(
          (cause) =>
            new TodoError({
              reason: "writeFailed",
              detail: "The to-do list could not be written to disk.",
              cause,
            }),
        ),
      );
      return { items: trimmed, updatedAt } satisfies TodoList;
    });

  return TodoStore.of({ read, write });
});

export const layer = Layer.effect(TodoStore, make);

/** An in-memory list, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.sync(TodoStore, () => {
  let items: ReadonlyArray<TodoItem> = [];
  let updatedAt = "1970-01-01T00:00:00.000Z";
  return TodoStore.of({
    read: Effect.sync(() => ({ items, updatedAt })),
    write: (next) =>
      Effect.gen(function* () {
        items = next;
        updatedAt = DateTime.formatIso(yield* DateTime.now);
        return { items, updatedAt };
      }),
  });
});
