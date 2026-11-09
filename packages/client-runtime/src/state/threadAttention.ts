// @effect-diagnostics globalDate:off -- Compares wall-clock stamps from the shell against the visit watermark.

const ATTENTION_PHASES = [
  "waiting_for_approval",
  "waiting_for_input",
  "failed",
  "completed",
] as const;

export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

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
