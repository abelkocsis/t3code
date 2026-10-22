import { compareSemverVersions } from "@t3tools/shared/semver";

import { UPSTREAM_BASE_TAG, UPSTREAM_REPOSITORY } from "./upstreamBase";

/**
 * Whether upstream has published a stable release newer than the one this fork
 * is built on.
 *
 * Matched by tag shape rather than by excluding names, for the reason
 * `scripts/fork-update.sh` gives: upstream also publishes nightly and preview
 * tags, and this fork publishes its own `-bitsafe` ones, so an exclude list has
 * to grow for each.
 */
const STABLE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export interface UpstreamRelease {
  readonly tag: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface UpstreamReleaseStatus {
  readonly baseTag: string;
  readonly latest: UpstreamRelease;
  readonly isBehind: boolean;
}

function releasePageUrl(tag: string): string {
  return `https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/${tag}`;
}

/**
 * The newest stable release in a GitHub releases payload, or `null` when the
 * payload holds none. Compared by version rather than by position: the API
 * orders by creation date, and a patch cut after a later minor would otherwise
 * win.
 */
export function selectLatestStableRelease(payload: unknown): UpstreamRelease | null {
  if (!Array.isArray(payload)) return null;
  let latest: UpstreamRelease | null = null;
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true || record.prerelease === true) continue;
    const tag = typeof record.tag_name === "string" ? record.tag_name : null;
    if (tag === null || !STABLE_TAG_PATTERN.test(tag)) continue;
    if (latest !== null && compareSemverVersions(tag.slice(1), latest.tag.slice(1)) <= 0) continue;
    latest = {
      tag,
      url: typeof record.html_url === "string" ? record.html_url : releasePageUrl(tag),
      publishedAt: typeof record.published_at === "string" ? record.published_at : null,
    };
  }
  return latest;
}

export function resolveUpstreamReleaseStatus(
  release: UpstreamRelease | null,
  baseTag: string = UPSTREAM_BASE_TAG,
): UpstreamReleaseStatus | null {
  if (release === null || !STABLE_TAG_PATTERN.test(baseTag)) return null;
  return {
    baseTag,
    latest: release,
    isBehind: compareSemverVersions(release.tag.slice(1), baseTag.slice(1)) > 0,
  };
}

export async function fetchLatestUpstreamRelease(
  signal?: AbortSignal,
): Promise<UpstreamRelease | null> {
  const response = await fetch(
    `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases?per_page=30`,
    {
      headers: { Accept: "application/vnd.github+json" },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the upstream releases.`);
  }
  return selectLatestStableRelease(await response.json());
}
