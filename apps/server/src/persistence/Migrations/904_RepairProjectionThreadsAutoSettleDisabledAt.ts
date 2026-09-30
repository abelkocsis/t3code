/**
 * Runs upstream migration 54 for databases this fork advanced past it.
 *
 * See 903_RepairPullRequestFilesViewed for why the migration is skipped.
 * Migration 54 adds its column only when `PRAGMA table_info` does not report
 * it, so replaying it is a no-op on a healthy database.
 */
export { default } from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";
