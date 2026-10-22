import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../persistence/Migrations.ts";

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("legacy fork ledger", () => {
  it.effect("lets upstream's v2 migrations run on a database the old fork wrote", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      // The old fork briefly numbered a repair 55 and then moved to 900+.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
          (55, 'RepairForkedThreadMessages', '2026-09-16 00:00:00'),
          (900, 'ProjectionThreadsScheduledMessage', '2026-09-30 00:00:00'),
          (908, 'ProjectionThreadsFolderId', '2026-10-06 00:00:00'),
          (910, 'ProjectionThreadsFactory', '2026-10-13 00:00:00')
      `;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN folder_id TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN factory_json TEXT`;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67],
      );
      const ledger = yield* readLedger;
      assert.strictEqual(ledger.at(-1)?.[0], 67);
      assert.deepStrictEqual(
        ledger.filter(([id]) => id === 55).map(([, name]) => name),
        ["OrchestrationV2"],
      );
      assert.isFalse(ledger.some(([id]) => id >= 900));
      // The import columns survive for the fork's own importer.
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "folder_id"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a current ledger alone", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const before = yield* readLedger;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readLedger, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
