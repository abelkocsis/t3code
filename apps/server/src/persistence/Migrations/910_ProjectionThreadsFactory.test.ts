import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateFactory from "./910_ProjectionThreadsFactory.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("910_ProjectionThreadsFactory", (it) => {
  it.effect("adds the column with existing threads left outside the factory", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 909 });
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
      yield* runMigrations({ toMigrationInclusive: 910 });
      const migrated = yield* sql<{ readonly factory: string | null }>`
        SELECT factory_json AS "factory" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ factory: null }]);
      // Re-running against a database that already has the column keeps it.
      yield* sql`UPDATE projection_threads SET factory_json = '{}' WHERE thread_id = 'thread-1'`;
      yield* migrateFactory;
      const rows = yield* sql<{ readonly factory: string | null }>`
        SELECT factory_json AS "factory" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ factory: "{}" }]);
    }),
  );
});
