/**
 * The fork's own migration ledger.
 *
 * Upstream's migrator skips every id at or below the highest recorded one,
 * whatever name it carries, so a fork id inside `effect_sql_migrations` masks
 * whichever upstream migration later claims that number (see
 * docs/internals/legacy-orchestration-migration.md). These migrations record
 * themselves in `fork_sql_migrations` instead and only ever create tables
 * prefixed `fork_`, so the two ledgers never meet.
 *
 * Add a migration by appending to `forkMigrationEntries`. Never renumber or
 * remove one that has shipped.
 *
 * @module ForkMigrations
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const ForkThreadState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_state (
      thread_id TEXT PRIMARY KEY,
      folder_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_thread_state_folder_id
    ON fork_thread_state(folder_id)
  `;
});

/**
 * Carries the fork's per-thread columns over from the v1 `projection_threads`
 * table, which the v2 copy of the database still holds. The old fork added
 * `folder_id` there with its own migration, so the column exists only on a
 * database that ran the old fork; a pristine upstream database has nothing
 * to import.
 */
const ImportLegacyThreadState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("folder_id")) return;
  yield* sql`
    INSERT OR IGNORE INTO fork_thread_state (thread_id, folder_id, updated_at)
    SELECT thread_id, folder_id, updated_at
    FROM projection_threads
    WHERE folder_id IS NOT NULL
  `;
});

/** The code-factory task state of a thread, as JSON (see `ThreadFactory` in contracts). */
const ForkThreadFactory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fork_thread_state ADD COLUMN factory_json TEXT`;
});

/**
 * Carries the old fork's `projection_threads.factory_json` over, the same way the folder
 * import does. A pristine upstream database has no such column and nothing to import.
 */
const ImportLegacyThreadFactory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "factory_json")) return;
  yield* sql`
    INSERT INTO fork_thread_state (thread_id, folder_id, updated_at, factory_json)
    SELECT thread_id, NULL, updated_at, factory_json
    FROM projection_threads
    WHERE factory_json IS NOT NULL
    ON CONFLICT (thread_id) DO UPDATE SET factory_json = excluded.factory_json
  `;
});

export const forkMigrationEntries: ReadonlyArray<
  readonly [
    id: number,
    name: string,
    migration: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
  ]
> = [
  [1, "ForkThreadState", ForkThreadState],
  [2, "ImportLegacyThreadState", ImportLegacyThreadState],
  [3, "ForkThreadFactory", ForkThreadFactory],
  [4, "ImportLegacyThreadFactory", ImportLegacyThreadFactory],
];

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
