import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const messageEvent = (input: {
  readonly sequence: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
}) => ({
  ...input,
  eventId: `event-${input.sequence}`,
  payload: JSON.stringify({ threadId: input.threadId, messageId: input.messageId }),
});

layer("055_RepairForkedThreadMessages", (it) => {
  it.effect("gives a forked message back to the thread that wrote it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const events = [
        messageEvent({
          sequence: 1,
          threadId: "source-thread",
          messageId: "message-1",
          commandId: "client-command",
        }),
        messageEvent({
          sequence: 2,
          threadId: "fork-thread",
          messageId: "message-1",
          commandId: "server:thread-fork-hydrate:abc",
        }),
      ];
      for (const event of events) {
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            ${event.sequence}, ${event.eventId}, 'thread', ${event.threadId}, ${event.sequence},
            'thread.message-sent', '2026-01-01T00:00:00.000Z', ${event.commandId}, 'user',
            ${event.payload}, '{}'
          )
        `;
      }
      // The hydrate overwrote the source thread's row, so the fork owns it.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-1', 'fork-thread', NULL, 'user', 'hello', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const rows = yield* sql<{
        readonly message_id: string;
        readonly thread_id: string;
        readonly text: string;
      }>`
        SELECT message_id, thread_id, text
        FROM projection_thread_messages
        ORDER BY thread_id
      `;

      assert.deepEqual(
        rows.map((row) => [row.thread_id, row.message_id, row.text]),
        [
          ["fork-thread", "fork:fork-thread:message-1", "hello"],
          ["source-thread", "message-1", "hello"],
        ],
      );
    }),
  );

  it.effect("leaves a thread that was never forked alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'message-plain', 'plain-thread', NULL, 'user', 'hello', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const rows = yield* sql<{ readonly message_id: string; readonly thread_id: string }>`
        SELECT message_id, thread_id
        FROM projection_thread_messages
        WHERE thread_id = 'plain-thread'
      `;

      assert.deepEqual(
        rows.map((row) => [row.thread_id, row.message_id]),
        [["plain-thread", "message-plain"]],
      );
    }),
  );
});
