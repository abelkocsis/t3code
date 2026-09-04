import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AwarenessThreadShell } from "@t3tools/shared/agentAwareness";
import {
  detectPhaseChanges,
  isPhaseNotifiable,
  isThreadAttentionUnseen,
  resolveThreadAttention,
  type ThreadPhaseMap,
} from "./threadAttention.ts";

const THREAD_UPDATED_AT = "2026-04-10T12:00:00.000Z";
const SESSION_UPDATED_AT = "2026-04-10T11:30:00.000Z";
const TURN_COMPLETED_AT = "2026-04-10T11:00:00.000Z";

function makeThread(input: {
  readonly sessionStatus?: "starting" | "running" | "ready" | "idle" | "error";
  readonly pending?: "approval" | "user-input";
  readonly turnState?: "running" | "completed" | "error";
  readonly turnCompletedAt?: string | null;
  readonly updatedAt?: string;
}): AwarenessThreadShell {
  const threadId = ThreadId.make("thread-1");
  return {
    id: threadId,
    title: "Fix participant reconnect loop",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    updatedAt: input.updatedAt ?? THREAD_UPDATED_AT,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionStatus === "error" ? "boom" : null,
            updatedAt: SESSION_UPDATED_AT,
          },
    latestTurn:
      input.turnState === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: input.turnState,
            requestedAt: TURN_COMPLETED_AT,
            startedAt: null,
            completedAt:
              input.turnCompletedAt === undefined ? TURN_COMPLETED_AT : input.turnCompletedAt,
            assistantMessageId: null,
          },
  };
}

describe("resolveThreadAttention", () => {
  it("reports a pending approval and stamps it with the thread's own update time", () => {
    expect(resolveThreadAttention(makeThread({ pending: "approval" }))).toEqual({
      phase: "waiting_for_approval",
      at: THREAD_UPDATED_AT,
    });
  });

  it("ranks a pending approval above a pending question, matching the relay", () => {
    const thread = { ...makeThread({ pending: "approval" }), hasPendingUserInput: true };
    expect(resolveThreadAttention(thread)?.phase).toBe("waiting_for_approval");
  });

  it("stamps a failure with the session status edge, not the thread row", () => {
    expect(resolveThreadAttention(makeThread({ sessionStatus: "error" }))).toEqual({
      phase: "failed",
      at: SESSION_UPDATED_AT,
    });
  });

  it("stamps a completion with the turn's completion time", () => {
    expect(resolveThreadAttention(makeThread({ turnState: "completed" }))).toEqual({
      phase: "completed",
      at: TURN_COMPLETED_AT,
    });
  });

  it("falls back to the session time when a completed turn carries no timestamp", () => {
    const attention = resolveThreadAttention(
      makeThread({ sessionStatus: "ready", turnState: "completed", turnCompletedAt: null }),
    );
    expect(attention).toEqual({ phase: "completed", at: SESSION_UPDATED_AT });
  });

  it("ignores a thread that is still working", () => {
    expect(resolveThreadAttention(makeThread({ sessionStatus: "running" }))).toBeNull();
  });

  it("ignores a thread that has never run", () => {
    expect(resolveThreadAttention(makeThread({}))).toBeNull();
  });
});

describe("isThreadAttentionUnseen", () => {
  const attention = { phase: "completed", at: THREAD_UPDATED_AT } as const;

  it("counts a phase newer than the last visit as unseen", () => {
    expect(isThreadAttentionUnseen({ attention, lastVisitedAt: "2026-04-10T11:00:00.000Z" })).toBe(
      true,
    );
  });

  it("counts a phase older than the last visit as seen", () => {
    expect(isThreadAttentionUnseen({ attention, lastVisitedAt: "2026-04-10T13:00:00.000Z" })).toBe(
      false,
    );
  });

  it("treats a never-visited thread as seen so other devices' work stays quiet", () => {
    expect(isThreadAttentionUnseen({ attention, lastVisitedAt: null })).toBe(false);
  });

  it("treats a malformed visit stamp as unseen rather than swallowing the signal", () => {
    expect(isThreadAttentionUnseen({ attention, lastVisitedAt: "not-a-date" })).toBe(true);
  });
});

describe("isPhaseNotifiable", () => {
  const allOn = {
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };

  it("maps each phase to its own switch", () => {
    expect(isPhaseNotifiable("waiting_for_approval", { ...allOn, notifyOnApproval: false })).toBe(
      false,
    );
    expect(isPhaseNotifiable("waiting_for_input", { ...allOn, notifyOnInput: false })).toBe(false);
    expect(isPhaseNotifiable("completed", { ...allOn, notifyOnCompletion: false })).toBe(false);
    expect(isPhaseNotifiable("failed", { ...allOn, notifyOnFailure: false })).toBe(false);
  });

  it("passes every phase when all switches are on", () => {
    expect(isPhaseNotifiable("completed", allOn)).toBe(true);
  });
});

describe("detectPhaseChanges", () => {
  const empty: ThreadPhaseMap = new Map();

  it("reports no change for a thread seen for the first time", () => {
    const result = detectPhaseChanges(empty, [{ key: "env:thread-1", phase: "completed" }]);
    expect(result.changes).toEqual([]);
    expect(result.next.get("env:thread-1")).toBe("completed");
  });

  it("reports a change once a known thread moves to another phase", () => {
    const first = detectPhaseChanges(empty, [{ key: "env:thread-1", phase: "running" }]);
    const second = detectPhaseChanges(first.next, [{ key: "env:thread-1", phase: "completed" }]);
    expect(second.changes).toEqual([
      { key: "env:thread-1", phase: "completed", previousPhase: "running" },
    ]);
  });

  it("stays quiet while a thread holds its phase", () => {
    const first = detectPhaseChanges(empty, [{ key: "env:thread-1", phase: "completed" }]);
    const second = detectPhaseChanges(first.next, [{ key: "env:thread-1", phase: "completed" }]);
    expect(second.changes).toEqual([]);
  });

  it("announces a second completion after the thread runs again", () => {
    const seen = detectPhaseChanges(empty, [{ key: "env:thread-1", phase: "completed" }]);
    const rerun = detectPhaseChanges(seen.next, [{ key: "env:thread-1", phase: "running" }]);
    const done = detectPhaseChanges(rerun.next, [{ key: "env:thread-1", phase: "completed" }]);
    expect(done.changes).toHaveLength(1);
  });

  it("drops threads that leave the snapshot so a return counts as a first sight", () => {
    const seen = detectPhaseChanges(empty, [{ key: "env:thread-1", phase: "running" }]);
    const gone = detectPhaseChanges(seen.next, []);
    expect(gone.next.size).toBe(0);
    const back = detectPhaseChanges(gone.next, [{ key: "env:thread-1", phase: "completed" }]);
    expect(back.changes).toEqual([]);
  });

  it("keeps environments apart when two threads share an id", () => {
    const first = detectPhaseChanges(empty, [
      { key: "env-a:thread-1", phase: "running" },
      { key: "env-b:thread-1", phase: "running" },
    ]);
    const second = detectPhaseChanges(first.next, [
      { key: "env-a:thread-1", phase: "completed" },
      { key: "env-b:thread-1", phase: "running" },
    ]);
    expect(second.changes).toEqual([
      { key: "env-a:thread-1", phase: "completed", previousPhase: "running" },
    ]);
  });
});
