import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { TodoError, TodoItem, type TodoList } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const MAX_TODO_ITEMS = 500;

export const ARCHIVE_RETENTION_MS = 30 * 86_400_000;

/** A hard stop on the archive, so a clear-happy day cannot grow the file. */
const MAX_ARCHIVED_ITEMS = 500;

const CURRENT_VERSION = 2;

const TodoDocument = Schema.Struct({
  version: Schema.Number,
  items: Schema.Array(TodoItem),
  /**
   * Done items the user cleared, newest first. A version 1 file has none, so
   * the field is optional.
   */
  archive: Schema.optional(Schema.Array(TodoItem)),
  updatedAt: Schema.String,
});

export class TodoStore extends Context.Service<
  TodoStore,
  {
    readonly read: Effect.Effect<TodoList, TodoError>;
    /** Replaces the list and answers with what was stored. */
    readonly write: (items: ReadonlyArray<TodoItem>) => Effect.Effect<TodoList, TodoError>;

    readonly readCompleted: Effect.Effect<ReadonlyArray<TodoItem>, TodoError>;
  }
>()("t3/todos/TodoStore") {}

function stampItem(input: {
  readonly item: TodoItem;
  readonly previous: TodoItem | undefined;
  readonly nowIso: string;
}): TodoItem {
  const { item, previous, nowIso } = input;
  const createdAt = previous?.createdAt ?? nowIso;
  if (!item.done) return { itemId: item.itemId, text: item.text, done: false, createdAt };
  const doneAt = previous?.done === true ? (previous.doneAt ?? nowIso) : nowIso;
  return { itemId: item.itemId, text: item.text, done: true, createdAt, doneAt };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(TodoDocument));
  const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(TodoDocument));
  const storePath = path.join(config.stateDir, "todos.json");

  const readDocument = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(storePath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return null;
    return yield* decodeDocument(raw).pipe(Effect.catchCause(() => Effect.succeed(null)));
  });

  const read: Effect.Effect<TodoList, TodoError> = Effect.gen(function* () {
    const document = yield* readDocument;
    if (document === null) return { items: [], updatedAt: DateTime.formatIso(yield* DateTime.now) };
    return { items: document.items, updatedAt: document.updatedAt };
  });

  const readCompleted: Effect.Effect<ReadonlyArray<TodoItem>, TodoError> = Effect.gen(function* () {
    const document = yield* readDocument;
    if (document === null) return [];
    const live = document.items.filter((item) => item.done);
    const liveIds = new Set(live.map((item) => item.itemId));
    return [...live, ...(document.archive ?? []).filter((item) => !liveIds.has(item.itemId))];
  });

  const pruneArchive = (items: ReadonlyArray<TodoItem>, nowMs: number): ReadonlyArray<TodoItem> => {
    const kept = items.filter((item) => {
      if (item.doneAt === undefined) return false;
      const doneMs = Date.parse(item.doneAt);
      return Number.isFinite(doneMs) && nowMs - doneMs <= ARCHIVE_RETENTION_MS;
    });
    return kept.slice(0, MAX_ARCHIVED_ITEMS);
  };

  const write = Effect.fn("TodoStore.write")(function* (items: ReadonlyArray<TodoItem>) {
    const now = yield* DateTime.now;
    const updatedAt = DateTime.formatIso(now);
    const previous = yield* readDocument;
    const previousById = new Map(
      (previous?.items ?? []).map((item) => [item.itemId, item] as const),
    );
    const trimmed = items
      .slice(0, MAX_TODO_ITEMS)
      .map((item) =>
        stampItem({ item, previous: previousById.get(item.itemId), nowIso: updatedAt }),
      );

    // An item the user cleared leaves the list, so the archive is the only
    // place the summary can still find the day it was ticked off.
    const keptIds = new Set(trimmed.map((item) => item.itemId));
    const cleared = (previous?.items ?? []).filter(
      (item) => item.done && !keptIds.has(item.itemId),
    );
    const clearedIds = new Set(cleared.map((item) => item.itemId));
    const archive = pruneArchive(
      [...cleared, ...(previous?.archive ?? []).filter((item) => !clearedIds.has(item.itemId))],
      DateTime.toEpochMillis(now),
    );

    const encoded = yield* encodeDocument({
      version: CURRENT_VERSION,
      items: trimmed,
      archive,
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

  return TodoStore.of({ read, write, readCompleted });
});

export const layer = Layer.effect(TodoStore, make);
