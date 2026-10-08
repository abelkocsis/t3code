import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateSlackThread from "./909_ProjectionThreadsSlackThread.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "909_ProjectionThreadsSlackThread",
  (it) => {
    it.effect("adds the column with existing threads left unlinked", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 908 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
        yield* runMigrations({ toMigrationInclusive: 909 });
        const migrated = yield* sql<{ readonly slackThread: string | null }>`
        SELECT slack_thread_json AS "slackThread" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(migrated, [{ slackThread: null }]);
        // Re-running against a database that already has the column keeps it.
        yield* sql`UPDATE projection_threads SET slack_thread_json = '{}' WHERE thread_id = 'thread-1'`;
        yield* migrateSlackThread;
        const rows = yield* sql<{ readonly slackThread: string | null }>`
        SELECT slack_thread_json AS "slackThread" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(rows, [{ slackThread: "{}" }]);
      }),
    );
  },
);
