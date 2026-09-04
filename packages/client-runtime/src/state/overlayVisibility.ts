// @effect-diagnostics globalDate:off -- Compares a client-local hide deadline against the current time.
import type { AttentionPhase } from "./threadAttention.ts";

/**
 * How the overlay window presents itself.
 *
 * "full" lists the threads the user has not seen. "pill" is the resting state:
 * a small bar proving the overlay is alive without covering the screen.
 * "hidden" puts nothing on screen at all.
 */
export type OverlayMode = "hidden" | "pill" | "full";

export interface OverlayItem {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectTitle: string | null;
  readonly phase: AttentionPhase;
}

export interface OverlayState {
  readonly mode: OverlayMode;
  readonly items: readonly OverlayItem[];
  readonly workingCount: number;
}

export interface OverlayVisibilityInput {
  readonly enabled: boolean;
  /** ISO time the temporary hide expires, or null when nothing is hidden. */
  readonly hiddenUntil: string | null;
  readonly now: string;
  /** True while the user is looking at the T3 Code window itself. */
  readonly appFocused: boolean;
  /** Threads whose current phase the user has not seen. */
  readonly unseen: readonly OverlayItem[];
  /** Threads with an agent still running, for the resting pill. */
  readonly workingCount: number;
}

/**
 * What the overlay should show right now.
 *
 * The order of the rules is the design: the user's own switch outranks
 * everything, a temporary hide outranks the content, and looking at T3 Code
 * outranks having something to report — the sidebar already says it, so a
 * floating window over the app would only repeat itself.
 */
export function resolveOverlayState(input: OverlayVisibilityInput): OverlayState {
  const hidden: OverlayState = { mode: "hidden", items: [], workingCount: 0 };
  if (!input.enabled) return hidden;
  if (isOverlayHiddenNow({ hiddenUntil: input.hiddenUntil, now: input.now })) return hidden;
  if (input.appFocused) return hidden;
  return {
    mode: input.unseen.length === 0 ? "pill" : "full",
    items: input.unseen,
    workingCount: input.workingCount,
  };
}

/**
 * Whether a temporary hide is still in force. A deadline that has passed, or
 * one that cannot be parsed, never keeps the overlay hidden: a corrupt value
 * must not switch the feature off for good.
 */
export function isOverlayHiddenNow(input: {
  readonly hiddenUntil: string | null;
  readonly now: string;
}): boolean {
  if (input.hiddenUntil === null) return false;
  const hiddenUntilMs = Date.parse(input.hiddenUntil);
  if (Number.isNaN(hiddenUntilMs)) return false;
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) return false;
  return hiddenUntilMs > nowMs;
}

export type OverlayHideDuration = "hour" | "tomorrow" | "indefinitely";

export interface OverlayHideChoice {
  readonly id: OverlayHideDuration;
  readonly label: string;
  /** Clock time the overlay returns, or null when it needs switching back on. */
  readonly whenLabel: string | null;
}

const HOUR_MS = 60 * 60 * 1_000;
const MORNING_HOUR = 9;

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The wake time for a hide choice, or null for "until I turn it back on",
 * which switches the feature off instead of scheduling a return.
 */
export function resolveOverlayHideUntil(duration: OverlayHideDuration, now: Date): string | null {
  if (duration === "indefinitely") return null;
  if (duration === "hour") return new Date(now.getTime() + HOUR_MS).toISOString();
  // Calendar-day advance rather than adding 24 hours: a fixed offset lands on
  // the wrong local day across a daylight-saving change.
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(MORNING_HOUR, 0, 0, 0);
  return tomorrow.toISOString();
}

/** The overlay menu's hide choices, worded like the app's snooze menu. */
export function resolveOverlayHideChoices(now: Date): readonly OverlayHideChoice[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(MORNING_HOUR, 0, 0, 0);
  return [
    { id: "hour", label: "For 1 hour", whenLabel: timeOfDayLabel(inAnHour) },
    { id: "tomorrow", label: "Until tomorrow", whenLabel: timeOfDayLabel(tomorrow) },
    { id: "indefinitely", label: "Until I turn it back on", whenLabel: null },
  ];
}
