import { LIVE_REFRESH_MIN_INTERVAL_MS } from "~/hooks/useLiveRefresh";

/**
 * When each pull request was last read past the server's cache on arrival, kept outside React so
 * it outlives the remount that opening the page causes.
 */
const lastHostRefreshAt = new Map<string, number>();

export function shippingHostRefreshKey(input: {
  readonly environmentId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${input.environmentId}:${input.host.toLowerCase()}:${input.repository.toLowerCase()}#${input.number}`;
}

/**
 * Whether arriving at the page should read a pull request from the host again, recording the
 * read when it should. Every such read spends host quota and wakes every other client, so
 * flicking in and out of the page costs one read per pull request per interval.
 */
export function claimShippingHostRefresh(key: string, now = Date.now()): boolean {
  const last = lastHostRefreshAt.get(key);
  if (last !== undefined && now - last < LIVE_REFRESH_MIN_INTERVAL_MS) return false;
  lastHostRefreshAt.set(key, now);
  return true;
}
