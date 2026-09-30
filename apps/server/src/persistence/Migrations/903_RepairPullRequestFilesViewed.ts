/**
 * Runs upstream migration 53 for databases this fork advanced past it.
 *
 * This fork once numbered its own migrations 53, 54 and 55. Upstream v0.0.44
 * then claimed 53 and 54 for its own. The runner advances by high-water mark
 * rather than by id, so a database that already recorded 55 never runs
 * upstream's 53, and the server then fails its first pull-request query with
 * `no such table: pull_request_files_viewed`.
 *
 * Migration 53 only uses `CREATE TABLE IF NOT EXISTS`, so replaying it is a
 * no-op on a healthy database and a repair on an affected one. Re-exporting it
 * keeps the schema in one place rather than copying the DDL into a second file.
 */
export { default } from "./053_PullRequestFilesViewed.ts";
