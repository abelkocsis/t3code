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

/**
 * How long a cleared item stays in the archive.
 *
 * The archive exists so the daily summary can still report an item the user
 * ticked off and then cleared. A summary covers one recent day, so a month
 * covers every day the user can still ask for.
 */
export const ARCHIVE_RETENTION_MS = 30 * 86_400_000;

/** A hard stop on the archive, so a clear-happy day cannot grow the file. */
export const MAX_ARCHIVED_ITEMS = 500;

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
    /**
     * Every item the user has ticked off, still on the list or already cleared.
     *
     * The daily summary reads this and keeps the items whose `doneAt` falls in
     * the day it reports.
     */
    readonly readCompleted: Effect.Effect<ReadonlyArray<TodoItem>, TodoError>;
  }
>()("t3/todos/TodoStore") {}

/**
 * Carries the server's timestamps onto one item of an incoming list.
 *
 * The client sends the whole list on every change, with no timestamp it can be
 * trusted on, so the server derives both instants from what it already stored:
 * an item the previous list did not hold is new, and an item that was open and
 * is now done was ticked off just now. An item stored before this field existed
 * has no creation instant to recover, so it counts as created on this write.
 */
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

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(TodoDocument));
  const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(TodoDocument));
  const storePath = path.join(config.stateDir, "todos.json");

  /**
   * The stored document, or `null` when there is nothing usable on disk.
   *
   * A missing file is the normal first read, and an unreadable one is treated
   * the same rather than as an error, so a corrupt file leaves the panel usable
   * and the next write repairs it.
   */
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

  /**
   * Keeps the archive to the items a summary can still ask for.
   *
   * An item with no completion instant cannot be placed on a day, so it is
   * dropped rather than kept forever.
   */
  const pruneArchive = (items: ReadonlyArray<TodoItem>, nowMs: number): ReadonlyArray<TodoItem> => {
    const kept = items.filter((item) => {
      if (item.doneAt === undefined) return false;
      const doneMs = Date.parse(item.doneAt);
      return Number.isFinite(doneMs) && nowMs - doneMs <= ARCHIVE_RETENTION_MS;
    });
    return kept.slice(0, MAX_ARCHIVED_ITEMS);
  };

  const write = (items: ReadonlyArray<TodoItem>) =>
    Effect.gen(function* () {
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

/** An in-memory list, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.sync(TodoStore, () => {
  let items: ReadonlyArray<TodoItem> = [];
  let updatedAt = "1970-01-01T00:00:00.000Z";
  return TodoStore.of({
    read: Effect.sync(() => ({ items, updatedAt })),
    write: (next) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const previousById = new Map(items.map((item) => [item.itemId, item] as const));
        items = next.map((item) =>
          stampItem({ item, previous: previousById.get(item.itemId), nowIso }),
        );
        updatedAt = nowIso;
        return { items, updatedAt };
      }),
    readCompleted: Effect.sync(() => items.filter((item) => item.done)),
  });
});
