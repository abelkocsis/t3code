import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import {
  fetchLatestUpstreamRelease,
  resolveUpstreamReleaseStatus,
  type UpstreamRelease,
  type UpstreamReleaseStatus,
} from "../upstreamRelease";
import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

const STORAGE_KEY = "t3code:upstream-release:v1";

/**
 * Upstream tags a stable release every couple of days, so a check twice a day
 * is enough to hear about one the morning after. The answer is cached across
 * reloads because it is the same for every window on this machine.
 */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const CachedCheck = Schema.Struct({
  checkedAt: Schema.Number,
  release: Schema.NullOr(
    Schema.Struct({
      tag: Schema.String,
      url: Schema.String,
      publishedAt: Schema.NullOr(Schema.String),
    }),
  ),
});

let status: UpstreamReleaseStatus | null = null;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(release: UpstreamRelease | null): void {
  status = resolveUpstreamReleaseStatus(release);
  for (const listener of listeners) listener();
}

function readCache(): { checkedAt: number; release: UpstreamRelease | null } | null {
  try {
    return getLocalStorageItem(STORAGE_KEY, CachedCheck);
  } catch {
    // A cache this build cannot read is not worth a failure; the next check
    // overwrites it.
    return null;
  }
}

function writeCache(release: UpstreamRelease | null): void {
  try {
    setLocalStorageItem(STORAGE_KEY, { checkedAt: Date.now(), release }, CachedCheck);
  } catch {
    // Private browsing and a full quota both land here. The check still works,
    // it just runs again on the next load.
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const cached = readCache();
  if (cached !== null) publish(cached.release);
  if (cached !== null && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return;
  if (inFlight !== null) return;
  inFlight = fetchLatestUpstreamRelease()
    .then((release) => {
      writeCache(release);
      publish(release);
    })
    .catch(() => {
      // GitHub being unreachable or rate limiting is not something to report:
      // the row keeps showing the last answer, or nothing at all.
    })
    .finally(() => {
      inFlight = null;
    });
}

function subscribe(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UpstreamReleaseStatus | null {
  return status;
}

/**
 * The newest upstream stable release, against the one this fork is built on.
 * `null` until the first check answers, and whenever the check fails.
 */
export function useUpstreamRelease(): UpstreamReleaseStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
