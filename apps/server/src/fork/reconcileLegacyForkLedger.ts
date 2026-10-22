/**
 * Removes the old fork's rows from upstream's migration ledger.
 *
 * The fork on v0.0.45 recorded its own migrations in `effect_sql_migrations`
 * (one briefly as id 55, later 900 to 910). Upstream's migrator skips every id
 * at or below the highest recorded one, so those rows would hide upstream's
 * 55 to 67 forever and the server refuses to start. The columns and repairs
 * those migrations made stay in the v1 tables, where the fork's own import
 * (`ForkMigrations.ts`) still reads them, so dropping the rows loses nothing.
 * The fork now records itself in `fork_sql_migrations` and never touches this
 * ledger again.
 *
 * @module reconcileLegacyForkLedger
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const FIRST_LEGACY_FORK_ID = 900;
const OVERLOADED_UPSTREAM_ID = 55;
/** The one fork repair that shipped under id 55 before it moved to 902. */
const FORK_NAME_AT_55 = "RepairForkedThreadMessages";

export const reconcileLegacyForkLedger = Effect.fn("reconcileLegacyForkLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [];
  const legacy = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE migration_id >= ${FIRST_LEGACY_FORK_ID}
       OR (migration_id = ${OVERLOADED_UPSTREAM_ID} AND name = ${FORK_NAME_AT_55})
    ORDER BY migration_id
  `;
  if (legacy.length === 0) return [];
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id >= ${FIRST_LEGACY_FORK_ID}
       OR (migration_id = ${OVERLOADED_UPSTREAM_ID} AND name = ${FORK_NAME_AT_55})
  `;
  const removed = legacy.map((row) => `${row.migration_id}_${row.name}`);
  yield* Effect.log("Removed the old fork's rows from the upstream migration ledger").pipe(
    Effect.annotateLogs({ removed }),
  );
  return removed;
});
