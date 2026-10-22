/**
 * Pure day arithmetic for the daily summary, in the user's reporting zone.
 *
 * A standup covers a wall-clock day, not a UTC day: a turn that ran at 23:30
 * local belongs to that evening's work. `Intl.DateTimeFormat` is the only
 * reliable way to resolve a wall-clock day, so the offset is measured through
 * it rather than assumed.
 *
 * Days are plain `YYYY-MM-DD` strings and instants are epoch milliseconds, so
 * every function here is integer arithmetic with no date object in sight.
 *
 * @module standupDays
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MS_PER_DAY = 86_400_000;

export function isStandupDay(value: string): boolean {
  return DAY_PATTERN.test(value);
}

function parseDay(day: string): { year: number; month: number; date: number } {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`Not a YYYY-MM-DD day: ${day}`);
  return { year: Number(match[1]), month: Number(match[2]), date: Number(match[3]) };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Formats a UTC instant as `YYYY-MM-DD`, by the civil-from-days algorithm.
 *
 * Written out rather than delegated to a date object because the Effect lint
 * rules forbid one, and because the arithmetic is exact for every year here.
 */
function toUtcDay(timestampMs: number): string {
  const days = Math.floor(timestampMs / MS_PER_DAY);
  // Shift the epoch to 0000-03-01 so a leap day lands at the end of a cycle.
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const date = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(date, 2)}`;
}

/** The UTC instant at midnight of a civil date, by the days-from-civil algorithm. */
function utcMidnightMs(year: number, month: number, date: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + date - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return (era * 146_097 + dayOfEra - 719_468) * MS_PER_DAY;
}

/**
 * Milliseconds to add to a UTC instant to get the wall-clock reading in
 * `timeZone`.
 *
 * Returns 0 for a zone the runtime rejects, which degrades the feature to UTC
 * days rather than failing a summary the user asked for.
 */
function zoneOffsetMs(timestampMs: number, timeZone: string): number {
  let parts: ReadonlyArray<Intl.DateTimeFormatPart>;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(timestampMs);
  } catch {
    return 0;
  }
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  // `hour12: false` reports midnight as 24 in some runtimes.
  const hour = read("hour") % 24;
  const asUtc =
    utcMidnightMs(read("year"), read("month"), read("day")) +
    hour * 3_600_000 +
    read("minute") * 60_000 +
    read("second") * 1_000;
  return asUtc - timestampMs;
}

/**
 * The UTC instant at which `day` starts in `timeZone`.
 *
 * The offset is measured twice, because the offset that applies at the start of
 * a local day is not always the offset that applies at UTC midnight of the same
 * date.
 */
export function zonedDayStartMs(day: string, timeZone: string): number {
  const { year, month, date } = parseDay(day);
  const utcMidnight = utcMidnightMs(year, month, date);
  const firstGuess = utcMidnight - zoneOffsetMs(utcMidnight, timeZone);
  return utcMidnight - zoneOffsetMs(firstGuess, timeZone);
}

export interface StandupDayWindow {
  /** Inclusive UTC instant the day starts at. */
  readonly startMs: number;
  /** Exclusive UTC instant the day ends at. */
  readonly endMs: number;
}

/**
 * The half-open UTC window covering `day` in `timeZone`.
 *
 * The end is the start of the next date rather than a fixed 24 hours, so a day
 * that gains or loses an hour to daylight saving stays whole.
 */
export function standupDayWindow(day: string, timeZone: string): StandupDayWindow {
  return {
    startMs: zonedDayStartMs(day, timeZone),
    endMs: zonedDayStartMs(addDays(day, 1), timeZone),
  };
}

/** Shifts a `YYYY-MM-DD` day by whole days. */
export function addDays(day: string, delta: number): string {
  const { year, month, date } = parseDay(day);
  return toUtcDay(utcMidnightMs(year, month, date) + delta * MS_PER_DAY);
}

/** Formats an instant as the `YYYY-MM-DD` day it falls on in `timeZone`. */
export function toStandupDay(timestampMs: number, timeZone: string): string {
  return toUtcDay(timestampMs + zoneOffsetMs(timestampMs, timeZone));
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

/**
 * Formats a UTC instant the way the projections store one, so a window can be
 * compared against `created_at` as a plain string range.
 */
export function toIsoUtc(timestampMs: number): string {
  const dayMs = Math.floor(timestampMs / MS_PER_DAY) * MS_PER_DAY;
  const remainder = timestampMs - dayMs;
  const hour = Math.floor(remainder / 3_600_000);
  const minute = Math.floor((remainder % 3_600_000) / 60_000);
  const second = Math.floor((remainder % 60_000) / 1_000);
  const millisecond = remainder % 1_000;
  return `${toUtcDay(dayMs)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}Z`;
}

/** Reads an ISO-8601 UTC timestamp back to epoch milliseconds, or `null`. */
export function parseIsoUtc(value: string): number | null {
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;
  return (
    utcMidnightMs(Number(match[1]), Number(match[2]), Number(match[3])) +
    Number(match[4]) * 3_600_000 +
    Number(match[5]) * 60_000 +
    Number(match[6]) * 1_000 +
    Number((match[7] ?? "0").padEnd(3, "0"))
  );
}
