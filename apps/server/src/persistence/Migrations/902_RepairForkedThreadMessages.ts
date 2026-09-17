import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A thread fork used to copy the source thread's messages under their own ids.
// `projection_thread_messages.message_id` is the primary key, so each copy
// overwrote the source's row and moved it into the fork: the source thread lost
// its history, and a second fork of the same thread found nothing left to copy.
//
// Repair the projection only, as migration 46 does: the engine and the
// projectors bootstrap from projection rows and cursors, never a full replay,
// so the recorded events can stay as they are. The fork hydrate is the only
// writer of a message under a command id of `server:thread-fork-hydrate:%`,
// which is how a stolen row is identified below.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The fork keeps its copy under an id of its own. Prefixing the source id
  // keeps the new id unique per fork and repeatable, so a second run inserts
  // nothing new.
  yield* sql`
    WITH hydrated AS (
      SELECT DISTINCT
        stream_id AS fork_thread_id,
        json_extract(payload_json, '$.messageId') AS message_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.message-sent'
        AND command_id LIKE 'server:thread-fork-hydrate:%'
    ),
    forked AS (
      SELECT
        hydrated.fork_thread_id,
        hydrated.message_id,
        (
          SELECT source.stream_id
          FROM orchestration_events AS source
          WHERE source.aggregate_kind = 'thread'
            AND source.event_type = 'thread.message-sent'
            AND json_extract(source.payload_json, '$.messageId') = hydrated.message_id
            AND (
              source.command_id IS NULL
              OR source.command_id NOT LIKE 'server:thread-fork-hydrate:%'
            )
          ORDER BY source.sequence
          LIMIT 1
        ) AS source_thread_id
      FROM hydrated
    )
    INSERT OR IGNORE INTO projection_thread_messages (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at,
      attachments_json,
      context_json
    )
    SELECT
      'fork:' || forked.fork_thread_id || ':' || forked.message_id,
      forked.fork_thread_id,
      message.turn_id,
      message.role,
      message.text,
      message.is_streaming,
      message.created_at,
      message.updated_at,
      message.attachments_json,
      message.context_json
    FROM forked
    JOIN projection_thread_messages AS message
      ON message.message_id = forked.message_id
    WHERE forked.source_thread_id IS NOT NULL
      AND forked.source_thread_id <> forked.fork_thread_id
  `;

  // The row under the original id goes back to the thread that wrote it.
  yield* sql`
    WITH hydrated AS (
      SELECT DISTINCT
        stream_id AS fork_thread_id,
        json_extract(payload_json, '$.messageId') AS message_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.message-sent'
        AND command_id LIKE 'server:thread-fork-hydrate:%'
    ),
    forked AS (
      SELECT
        hydrated.fork_thread_id,
        hydrated.message_id,
        (
          SELECT source.stream_id
          FROM orchestration_events AS source
          WHERE source.aggregate_kind = 'thread'
            AND source.event_type = 'thread.message-sent'
            AND json_extract(source.payload_json, '$.messageId') = hydrated.message_id
            AND (
              source.command_id IS NULL
              OR source.command_id NOT LIKE 'server:thread-fork-hydrate:%'
            )
          ORDER BY source.sequence
          LIMIT 1
        ) AS source_thread_id
      FROM hydrated
    )
    UPDATE projection_thread_messages
    SET thread_id = (
      SELECT forked.source_thread_id
      FROM forked
      WHERE forked.message_id = projection_thread_messages.message_id
        AND forked.fork_thread_id = projection_thread_messages.thread_id
        AND forked.source_thread_id IS NOT NULL
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
      FROM forked
      WHERE forked.message_id = projection_thread_messages.message_id
        AND forked.fork_thread_id = projection_thread_messages.thread_id
        AND forked.source_thread_id IS NOT NULL
        AND forked.source_thread_id <> forked.fork_thread_id
    )
  `;
});
