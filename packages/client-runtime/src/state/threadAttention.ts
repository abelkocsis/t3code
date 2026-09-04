// @effect-diagnostics globalDate:off -- Compares wall-clock stamps from the shell against a client-local visit time.
import type { AgentAwarenessPhase, AwarenessThreadShell } from "@t3tools/shared/agentAwareness";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";

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
] as const satisfies readonly AgentAwarenessPhase[];

export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

export function isAttentionPhase(phase: AgentAwarenessPhase | null): phase is AttentionPhase {
  return phase !== null && (ATTENTION_PHASES as readonly string[]).includes(phase);
}

/**
 * A thread's current phase plus the timestamp that stamps it.
 *
 * The shell carries no dedicated "asked for approval at" field, so each phase
 * borrows the freshest timestamp that moves when the phase does: a completed
 * turn stamps its own completion, a failed session stamps its status edge, and
 * a pending request rides the thread's own updatedAt, which the
 * activity-appended projection bumps.
 */
export interface ThreadAttention {
  readonly phase: AttentionPhase;
  readonly at: string;
}

export function resolveThreadAttention(thread: AwarenessThreadShell): ThreadAttention | null {
  const phase = resolveThreadAwarenessPhase(thread);
  if (!isAttentionPhase(phase)) return null;
  return { phase, at: attentionTimestamp(phase, thread) };
}

function attentionTimestamp(phase: AttentionPhase, thread: AwarenessThreadShell): string {
  if (phase === "completed") {
    return thread.latestTurn?.completedAt ?? thread.session?.updatedAt ?? thread.updatedAt;
  }
  if (phase === "failed") {
    return thread.session?.updatedAt ?? thread.updatedAt;
  }
  return thread.updatedAt;
}

/**
 * Whether the user has looked at the thread since it entered this phase.
 *
 * A thread with no recorded visit counts as seen. Visits are client-local, so
 * treating "never visited" as unseen would light up every thread another
 * device already handled.
 */
export function isThreadAttentionUnseen(input: {
  readonly attention: ThreadAttention;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (input.lastVisitedAt == null) return false;
  const attentionAtMs = Date.parse(input.attention.at);
  if (Number.isNaN(attentionAtMs)) return false;
  const lastVisitedAtMs = Date.parse(input.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return attentionAtMs > lastVisitedAtMs;
}

/** Which phases the user asked to hear about. Mirrors RelayAgentAwarenessPreferences. */
export interface AttentionNotificationPreferences {
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
}

export function isPhaseNotifiable(
  phase: AttentionPhase,
  preferences: AttentionNotificationPreferences,
): boolean {
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
  }
}

export type ThreadPhaseMap = ReadonlyMap<string, AgentAwarenessPhase | null>;

export interface PhaseChangeInput {
  /** Stable per-environment thread key, so two environments never collide. */
  readonly key: string;
  readonly phase: AgentAwarenessPhase | null;
}

export interface PhaseChange {
  readonly key: string;
  readonly phase: AgentAwarenessPhase | null;
  readonly previousPhase: AgentAwarenessPhase | null;
}

export interface PhaseChangeResult {
  readonly changes: readonly PhaseChange[];
  readonly next: ThreadPhaseMap;
}

/**
 * The phase transitions since the last call.
 *
 * A thread seen for the first time reports no change, only a recorded phase.
 * Without that rule the first snapshot after launch would announce every
 * thread that finished while the app was closed, which is history, not news.
 * Threads that vanish from the snapshot drop out of the map so a later
 * reappearance is a first sight again.
 */
export function detectPhaseChanges(
  previous: ThreadPhaseMap,
  threads: readonly PhaseChangeInput[],
): PhaseChangeResult {
  const next = new Map<string, AgentAwarenessPhase | null>();
  const changes: PhaseChange[] = [];
  for (const thread of threads) {
    next.set(thread.key, thread.phase);
    if (!previous.has(thread.key)) continue;
    const previousPhase = previous.get(thread.key) ?? null;
    if (previousPhase === thread.phase) continue;
    changes.push({ key: thread.key, phase: thread.phase, previousPhase });
  }
  return { changes, next };
}
