/**
 * Re-runs migration 50 for databases this fork left without its table.
 *
 * This branch once numbered its scheduled-message migration 50. Upstream then
 * claimed 50 for `ProjectionThreadPullRequests`, and the branch's own migration
 * moved to 53. A database that had already run the old 50 records id 50 as
 * applied, and the runner advances by high-water mark rather than by id, so it
 * never runs upstream's 50. The server then crashes on its first pull-request
 * query with `no such table: projection_thread_pull_requests`.
 *
 * Migration 50 only uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
 * EXISTS` and `INSERT OR IGNORE`, so replaying it is a no-op on every healthy
 * database and a repair on the affected ones. Re-exporting it keeps the schema
 * in one place rather than copying the DDL into a second file.
 */
export { default } from "./050_ProjectionThreadPullRequests.ts";
