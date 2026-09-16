/**
 * Reads one day of T3 Code work straight out of the projections.
 *
 * The daily summary spans every project in the environment and needs threads,
 * their user messages and their finished turns together. The per-table
 * projection repositories only answer by id, so this module queries the
 * projection tables directly rather than making each of them grow a window
 * query that nothing else wants.
 *
 * Timestamps in the projections are ISO-8601 UTC strings of a fixed width, so a
 * window compares as a string range and the existing indexes still apply.
 *
 * @module StandupWorkQuery
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { StandupThreadFact } from "./standupFacts.ts";
import { FACT_LIMITS } from "./standupFacts.ts";
import { parseIsoUtc, toIsoUtc, type StandupDayWindow } from "./standupDays.ts";

/** Paths per thread. More than this says "a big refactor" just as well. */
const MAX_CHANGED_FILES_PER_THREAD = 12;

interface ThreadRow {
  readonly thread_id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly project_title: string;
}

interface MessageRow {
  readonly thread_id: string;
  readonly text: string;
}

interface TurnRow {
  readonly thread_id: string;
  readonly completed_turns: number;
  readonly checkpoint_files_json: string | null;
}

function parseChangedFiles(json: string | null): ReadonlyArray<string> {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path
          : null,
      )
      .filter((path): path is string => path !== null);
  } catch {
    return [];
  }
}

/**
 * Every thread that saw a message or finished a turn inside the window, with
 * what the user asked for and what the turns touched.
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
      t.branch AS branch,
      p.title AS project_title
    FROM projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.created_at >= ${since} AND m.created_at < ${until}
        )
        OR EXISTS (
          SELECT 1 FROM projection_turns r
          WHERE r.thread_id = t.thread_id AND r.completed_at >= ${since} AND r.completed_at < ${until}
        )
      )
    ORDER BY t.updated_at DESC
    LIMIT ${FACT_LIMITS.threads}
  `;
  if (threads.length === 0) return [] as ReadonlyArray<StandupThreadFact>;

  const threadIds = threads.map((thread) => thread.thread_id);

  const messages = yield* sql<MessageRow>`
    SELECT thread_id, text
    FROM projection_thread_messages
    WHERE role = 'user'
      AND created_at >= ${since}
      AND created_at < ${until}
      AND thread_id IN ${sql.in(threadIds)}
    ORDER BY created_at ASC
  `;

  const turns = yield* sql<TurnRow>`
    SELECT thread_id, COUNT(*) AS completed_turns, group_concat(checkpoint_files_json, '|') AS checkpoint_files_json
    FROM projection_turns
    WHERE completed_at >= ${since}
      AND completed_at < ${until}
      AND thread_id IN ${sql.in(threadIds)}
    GROUP BY thread_id
  `;

  const messagesByThread = new Map<string, string[]>();
  for (const message of messages) {
    const bucket = messagesByThread.get(message.thread_id) ?? [];
    if (bucket.length < FACT_LIMITS.messagesPerThread) bucket.push(message.text);
    messagesByThread.set(message.thread_id, bucket);
  }

  const turnsByThread = new Map<string, TurnRow>();
  for (const turn of turns) turnsByThread.set(turn.thread_id, turn);

  return threads.map((thread): StandupThreadFact => {
    const turn = turnsByThread.get(thread.thread_id);
    const changedFiles = (turn?.checkpoint_files_json ?? "")
      .split("|")
      .flatMap((chunk) => parseChangedFiles(chunk.length > 0 ? chunk : null));
    return {
      threadId: thread.thread_id,
      projectTitle: thread.project_title,
      title: thread.title,
      branch: thread.branch,
      userMessages: messagesByThread.get(thread.thread_id) ?? [],
      completedTurns: turn?.completed_turns ?? 0,
      changedFiles: [...new Set(changedFiles)].slice(0, MAX_CHANGED_FILES_PER_THREAD),
    };
  });
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
        SELECT MAX(created_at) AS latest FROM projection_thread_messages
        WHERE role = 'user' AND created_at < ${before}
        UNION ALL
        SELECT MAX(completed_at) AS latest FROM projection_turns WHERE completed_at < ${before}
      )
    `;
    const latest = rows[0]?.latest;
    if (!latest) return null;
    return parseIsoUtc(latest);
  },
);

/** Every project in the environment, so the collectors know which worktrees to read. */
export const readProjectRoots = Effect.fn("StandupWorkQuery.readProjectRoots")(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* sql<{ readonly title: string; readonly workspace_root: string }>`
    SELECT title, workspace_root
    FROM projection_projects
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC
  `;
});
