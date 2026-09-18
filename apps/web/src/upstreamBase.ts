/**
 * The upstream release this fork's branch sits on.
 *
 * `scripts/fork-update.sh` reads this line before a replay and rewrites it
 * after one, so the base is recorded in a single place. The runtime version of
 * a build says nothing here: upstream does not bump `package.json` per release
 * tag, and their tag v0.0.42 still carries version 0.0.40.
 */
export const UPSTREAM_BASE_TAG = "v0.0.42";

/** The repository the base tag comes from. */
export const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
