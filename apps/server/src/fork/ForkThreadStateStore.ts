/**
 * The fork's per-thread row: which folder a thread sits in, and later any other
 * state the fork keeps beside upstream's thread record.
 *
 * Writes go to `fork_thread_state` and then to a PubSub, so every client
 * subscribed over the wire sees the row change. The table is small, one row
 * per thread the fork has touched, so a subscription starts with the whole
 * table rather than a cursor.
 *
 * @module ForkThreadStateStore
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  ForkThreadStateError,
  ThreadFolderId,
  ThreadId,
  type ForkThreadState,
  type ForkThreadStateStreamEvent,
} from "@t3tools/contracts";

const Row = Schema.Struct({
  thread_id: ThreadId,
  folder_id: Schema.NullOr(ThreadFolderId),
  updated_at: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toState = (row: typeof Row.Type): ForkThreadState => ({
  threadId: row.thread_id,
  folderId: row.folder_id,
  updatedAt: row.updated_at,
});

export class ForkThreadStateStore extends Context.Service<
  ForkThreadStateStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ForkThreadState>, ForkThreadStateError>;
    readonly setFolder: (
      threadId: ThreadId,
      folderId: ThreadFolderId | null,
    ) => Effect.Effect<ForkThreadState, ForkThreadStateError>;
    /** The whole table, then one event per change, for as long as the stream is read. */
    readonly subscribe: Stream.Stream<ForkThreadStateStreamEvent, ForkThreadStateError>;
  }
>()("t3/fork/ForkThreadStateStore") {}

const sqlError = (operation: string) => (cause: unknown) =>
  new ForkThreadStateError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ForkThreadState>();

  const list = sql`
    SELECT thread_id, folder_id, updated_at FROM fork_thread_state ORDER BY updated_at
  `.pipe(
    Effect.flatMap(decodeRows),
    Effect.map((rows) => rows.map(toState)),
    Effect.mapError(sqlError("list")),
  );

  const read = (threadId: ThreadId) =>
    sql`
      SELECT thread_id, folder_id, updated_at FROM fork_thread_state WHERE thread_id = ${threadId}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map(toState)[0] ?? null),
      Effect.mapError(sqlError("read")),
    );

  const setFolder = Effect.fn("ForkThreadStateStore.setFolder")(function* (
    threadId: ThreadId,
    folderId: ThreadFolderId | null,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_thread_state (thread_id, folder_id, updated_at)
      VALUES (${threadId}, ${folderId}, ${updatedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        folder_id = excluded.folder_id,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(sqlError("setFolder")));
    const state = yield* read(threadId);
    if (state === null) {
      return yield* new ForkThreadStateError({
        operation: "setFolder",
        message: "The row vanished between write and read.",
      });
    }
    yield* PubSub.publish(changes, state);
    return state;
  });

  // Subscribe before the snapshot so a write between the two still arrives.
  const subscribe = Stream.unwrap(
    PubSub.subscribe(changes).pipe(
      Effect.map((subscription) =>
        Stream.concat(
          Stream.fromEffect(
            list.pipe(
              Effect.map((states): ForkThreadStateStreamEvent => ({ type: "snapshot", states })),
            ),
          ),
          Stream.fromSubscription(subscription).pipe(
            Stream.map((state): ForkThreadStateStreamEvent => ({ type: "updated", state })),
          ),
        ),
      ),
    ),
  );

  return ForkThreadStateStore.of({ list, setFolder, subscribe });
});

export const layer = Layer.effect(ForkThreadStateStore, make);
