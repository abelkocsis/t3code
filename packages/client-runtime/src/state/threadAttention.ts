// @effect-diagnostics globalDate:off -- Compares wall-clock stamps from the shell against the visit watermark.

/**
 * The phases that ask something of the user. Two of them block the agent
 * (approval, input) and two only report (failed, completed), but all four are
 * things a user who stepped away wants to hear about.
 */
export const ATTENTION_PHASES = [
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
  "completed",
] as const;

export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

/**
 * The sidebar's reading of a thread, which is the one attention derivation the
 * client has. The overlay reads the same value rather than walking the shell
 * itself, so the two surfaces can never disagree about what is waiting.
 */
export type AttentionSourceStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export interface AttentionThreadInput {
  readonly status: AttentionSourceStatus;
  readonly latestRun: {
    readonly status: string;
    readonly completedAt: string | null;
  } | null;
  readonly updatedAt: string;
  readonly settledOverride: "settled" | "active" | null;
  readonly snoozedUntil: string | null;
  readonly archivedAt: string | null;
}

/**
 * A thread's current phase plus the timestamp that stamps it.
 *
 * The shell carries no dedicated "asked for approval at" field, so each phase
 * borrows the freshest timestamp that moves when the phase does: a finished
 * run stamps its own completion, and a pending request rides the thread's own
 * updatedAt, which the request bumps.
 */
export interface ThreadAttention {
  readonly phase: AttentionPhase;
  readonly at: string;
}

function isSnoozedNow(thread: AttentionThreadInput, now: number): boolean {
  if (thread.snoozedUntil === null) return false;
  const wakeAtMs = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(wakeAtMs) && wakeAtMs > now;
}

export function resolveThreadAttention(
  thread: AttentionThreadInput,
  now: number = Date.now(),
): ThreadAttention | null {
  if (thread.archivedAt !== null) return null;
  // Settling is the user saying "I am done with this", so a settled thread
  // never asks for attention: no overlay row and no badge count. New work
  // unsettles the thread on the server, which restores both.
  if (thread.settledOverride === "settled") return null;
  // A snoozed thread was put down on purpose; it asks for nothing until it wakes.
  if (isSnoozedNow(thread, now)) return null;
  switch (thread.status) {
    case "approval":
      return { phase: "waiting_for_approval", at: thread.updatedAt };
    case "input":
      return { phase: "waiting_for_input", at: thread.updatedAt };
    case "failed":
    case "limited":
      return { phase: "failed", at: thread.latestRun?.completedAt ?? thread.updatedAt };
    case "ready":
      if (thread.latestRun?.status !== "completed" || thread.latestRun.completedAt === null) {
        return null;
      }
      return { phase: "completed", at: thread.latestRun.completedAt };
    case "working":
    case "waiting":
      return null;
  }
}

/**
 * Whether the user has looked at the thread since it entered this phase.
 *
 * A finished run on a thread with no recorded visit counts as seen, the same
 * way the sidebar reads it: a thread nobody ever opened is history, not news.
 * A question, an approval, or a failure on such a thread still counts, because
 * it needs someone whether or not anyone has opened the thread yet.
 */
export function isThreadAttentionUnseen(input: {
  readonly attention: ThreadAttention;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.lastVisitedAt == null) return input.attention.phase !== "completed";
  const attentionAtMs = Date.parse(input.attention.at);
  if (Number.isNaN(attentionAtMs)) return false;
  const lastVisitedAtMs = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return attentionAtMs > lastVisitedAtMs;
}

/**
 * Whether the user hid this thread from the overlay.
 *
 * A dismissal is stamped with the attention time it hid, so it covers that
 * phase only: newer work on the thread raises the row again. Unlike a visit, a
 * dismissal says nothing about the main UI, which keeps its unread mark.
 */
export function isThreadAttentionDismissed(input: {
  readonly attention: ThreadAttention;
  readonly dismissedAt: string | null | undefined;
}): boolean {
  if (input.dismissedAt == null) return false;
  const dismissedAtMs = Date.parse(input.dismissedAt);
  if (Number.isNaN(dismissedAtMs)) return false;
  const attentionAtMs = Date.parse(input.attention.at);
  if (Number.isNaN(attentionAtMs)) return false;
  return attentionAtMs <= dismissedAtMs;
}

/** Compact phase label for narrow surfaces such as the overlay rows. */
export function shortAttentionLabel(phase: AttentionPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
  }
}
