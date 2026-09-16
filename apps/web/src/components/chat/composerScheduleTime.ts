import type { UsageLimitsReport } from "@t3tools/contracts";

const HOUR_MS = 60 * 60 * 1_000;

/**
 * How far ahead the picker opens when no provider reports a reset time. The
 * feature exists for quota resets, so a short hop is a placeholder the user
 * is expected to edit, not a recommendation.
 */
export const SCHEDULE_FALLBACK_DELAY_MS = HOUR_MS;

/**
 * When the soonest exhausted quota window comes back.
 *
 * Session windows come first because they are the ones a user waits out. A
 * weekly or monthly reset only answers when no session window reports one.
 */
export function nextUsageLimitResetAt(
  report: UsageLimitsReport | null,
  nowMs: number,
): string | null {
  if (report === null) return null;
  let sessionReset: number | null = null;
  let otherReset: number | null = null;
  for (const account of report.accounts) {
    for (const window of account.limits.windows) {
      if (window.resetsAt === undefined) continue;
      const resetMs = Date.parse(window.resetsAt);
      if (Number.isNaN(resetMs) || resetMs <= nowMs) continue;
      if (window.kind === "session") {
        sessionReset = sessionReset === null ? resetMs : Math.min(sessionReset, resetMs);
      } else {
        otherReset = otherReset === null ? resetMs : Math.min(otherReset, resetMs);
      }
    }
  }
  const resolved = sessionReset ?? otherReset;
  return resolved === null ? null : new Date(resolved).toISOString();
}

/** The time the picker opens on: the next quota reset, else a short hop ahead. */
export function defaultScheduleDueAt(report: UsageLimitsReport | null, nowMs: number): string {
  return (
    nextUsageLimitResetAt(report, nowMs) ??
    new Date(nowMs + SCHEDULE_FALLBACK_DELAY_MS).toISOString()
  );
}

/** ISO instant to the local `YYYY-MM-DDTHH:mm` a datetime-local input takes. */
export function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The input's local time back to an ISO instant. Null when it is unusable. */
export function fromDateTimeLocalValue(value: string, nowMs: number): string | null {
  if (value.trim().length === 0) return null;
  const parsed = new Date(value);
  const parsedMs = parsed.getTime();
  if (Number.isNaN(parsedMs) || parsedMs <= nowMs) return null;
  return parsed.toISOString();
}
