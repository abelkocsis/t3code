import { LIVE_REFRESH_MIN_INTERVAL_MS } from "~/hooks/useLiveRefresh";

/**
 * When each pull request was last read past the server's cache on arrival, kept outside React so
 * it outlives the remount that opening a panel or switching threads causes.
 */
const lastHostRefreshAt = new Map<string, number>();

/** The key both the detail panel and the linked list use, so one arrival covers the other. */
export function pullRequestHostRefreshKey(input: {
  readonly environmentId: string;
  readonly host: string | undefined;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${input.environmentId}:${(input.host ?? "").toLowerCase()}:${input.repository.toLowerCase()}#${input.number}`;
}

/**
 * Whether arriving at a pull request should read it from the host again, recording the read when
 * it should. Every such read spends host quota and wakes every other client, so flicking between
 * threads costs one read per pull request per interval.
 */
export function claimPullRequestHostRefresh(key: string, now = Date.now()): boolean {
  const last = lastHostRefreshAt.get(key);
  if (last !== undefined && now - last < LIVE_REFRESH_MIN_INTERVAL_MS) return false;
  lastHostRefreshAt.set(key, now);
  return true;
}
