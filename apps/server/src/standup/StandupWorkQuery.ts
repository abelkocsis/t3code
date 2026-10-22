/**
 * Reads one day of T3 Code work straight out of the v2 projections.
 *
 * The daily summary spans every project in the environment and needs threads,
 * their user messages and their finished runs together. `ProjectionStore`
 * answers by thread id, so this module queries the projection tables directly
 * rather than making the store grow a window query that nothing else wants.
 * It reads only; the tables stay upstream's.
 *
 * Timestamps in the projections are ISO-8601 UTC strings of a fixed width, so a
 * window compares as a string range and the existing indexes still apply.
 *
 * @module StandupWorkQuery
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { StandupThreadFact } from "./standupFacts.ts";
import { FACT_LIMITS } from "./standupFacts.ts";
import { parseIsoUtc, toIsoUtc, type StandupDayWindow } from "./standupDays.ts";

interface ThreadRow {
  readonly thread_id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly project_title: string;
}

interface MessageRow {
  readonly thread_id: string;
  readonly text: string | null;
}

interface RunRow {
  readonly thread_id: string;
  readonly completed_runs: number;
}

/**
 * Every live thread that received a user message or finished a run inside the
 * window, with what the user asked for.
 *
 * A user message's `updated_at` is the instant it was recorded; nothing edits
 * one afterwards, so it stands in for a creation time.
 */
export const readThreadFacts = Effect.fn("StandupWorkQuery.readThreadFacts")(function* (
  sql: SqlClient.SqlClient,
  window: StandupDayWindow,
) {
  const since = toIsoUtc(window.startMs);
  const until = toIsoUtc(window.endMs);

  const threads = yield* sql<ThreadRow>`
    SELECT
      t.thread_id AS thread_id,
      t.title AS title,
      json_extract(t.payload_json, '$.branch') AS branch,
      p.title AS project_title
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items m
          WHERE m.thread_id = t.thread_id
            AND m.type = 'user_message'
            AND m.updated_at >= ${since} AND m.updated_at < ${until}
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.completed_at >= ${since} AND r.completed_at < ${until}
        )
      )
    ORDER BY t.updated_at DESC
    LIMIT ${FACT_LIMITS.threads}
  `;
  if (threads.length === 0) return [] as ReadonlyArray<StandupThreadFact>;

  const threadIds = threads.map((thread) => thread.thread_id);

  const messages = yield* sql<MessageRow>`
    SELECT thread_id, json_extract(payload_json, '$.text') AS text
    FROM orchestration_v2_projection_turn_items
    WHERE type = 'user_message'
      AND updated_at >= ${since}
      AND updated_at < ${until}
      AND thread_id IN ${sql.in(threadIds)}
    ORDER BY ordinal ASC
  `;

  const runs = yield* sql<RunRow>`
    SELECT thread_id, COUNT(*) AS completed_runs
    FROM orchestration_v2_projection_runs
    WHERE completed_at >= ${since}
      AND completed_at < ${until}
      AND thread_id IN ${sql.in(threadIds)}
    GROUP BY thread_id
  `;

  const messagesByThread = new Map<string, string[]>();
  for (const message of messages) {
    if (message.text === null || message.text.trim().length === 0) continue;
    const bucket = messagesByThread.get(message.thread_id) ?? [];
    if (bucket.length < FACT_LIMITS.messagesPerThread) bucket.push(message.text);
    messagesByThread.set(message.thread_id, bucket);
  }

  const runsByThread = new Map<string, number>();
  for (const run of runs) runsByThread.set(run.thread_id, Number(run.completed_runs));

  return threads.map((thread): StandupThreadFact => ({
    threadId: thread.thread_id,
    projectTitle: thread.project_title,
    title: thread.title,
    branch: thread.branch,
    userMessages: messagesByThread.get(thread.thread_id) ?? [],
    completedTurns: runsByThread.get(thread.thread_id) ?? 0,
    changedFiles: [],
  }));
});

/**
 * The most recent instant the environment recorded T3 work before `beforeMs`.
 *
 * Drives the day the panel opens on. The caller passes the start of today, so
 * a standup opens on the day being reported rather than on the morning that is
 * still in progress, and a Monday shows Friday rather than an empty Sunday.
 *
 * `null` when nothing was recorded in that range.
 */
export const readLatestWorkInstantMs = Effect.fn("StandupWorkQuery.readLatestWorkInstantMs")(
  function* (sql: SqlClient.SqlClient, beforeMs: number | null) {
    const before = beforeMs === null ? "9999-12-31T23:59:59.999Z" : toIsoUtc(beforeMs);
    const rows = yield* sql<{ readonly latest: string | null }>`
      SELECT MAX(latest) AS latest FROM (
        SELECT MAX(updated_at) AS latest FROM orchestration_v2_projection_turn_items
        WHERE type = 'user_message' AND updated_at < ${before}
        UNION ALL
        SELECT MAX(completed_at) AS latest FROM orchestration_v2_projection_runs
        WHERE completed_at < ${before}
      )
    `;
    const latest = rows[0]?.latest;
    if (!latest) return null;
    return parseIsoUtc(latest);
  },
);
