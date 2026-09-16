import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { isScheduledMessageSendable } from "./ScheduledMessagePolicy.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const DUE = "2026-08-28T11:00:00.000Z";
const NOT_DUE = "2026-08-28T13:00:00.000Z";

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo",
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  scheduledMessage: {
    messageId: MessageId.make("message-scheduled"),
    text: "run the tests",
    dueAt: DUE,
    scheduledAt: "2026-08-28T09:00:00.000Z",
  },
  session: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

describe("isScheduledMessageSendable", () => {
  it("sends a due message on an idle thread", () => {
    expect(isScheduledMessageSendable(makeThread(), NOW)).toBe(true);
  });

  it("waits while the due time is ahead", () => {
    const thread = makeThread({
      scheduledMessage: {
        messageId: MessageId.make("message-scheduled"),
        text: "run the tests",
        dueAt: NOT_DUE,
        scheduledAt: "2026-08-28T09:00:00.000Z",
      },
    });
    expect(isScheduledMessageSendable(thread, NOW)).toBe(false);
  });

  it("waits while a turn runs", () => {
    const thread = makeThread({
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(isScheduledMessageSendable(thread, NOW)).toBe(false);
  });

  it("waits while the thread is blocked on the user", () => {
    expect(isScheduledMessageSendable(makeThread({ hasPendingApprovals: true }), NOW)).toBe(false);
    expect(isScheduledMessageSendable(makeThread({ hasPendingUserInput: true }), NOW)).toBe(false);
  });

  it("waits while background work is alive", () => {
    expect(isScheduledMessageSendable(makeThread({ backgroundLiveness: "working" }), NOW)).toBe(
      false,
    );
  });

  it("waits while a just-sent message has no turn yet", () => {
    const thread = makeThread({ latestUserMessageAt: "2026-08-28T11:59:30.000Z" });
    expect(isScheduledMessageSendable(thread, NOW)).toBe(false);
  });

  it("never sends on an archived thread", () => {
    expect(isScheduledMessageSendable(makeThread({ archivedAt: NOW }), NOW)).toBe(false);
  });

  it("does nothing when no message is parked", () => {
    expect(isScheduledMessageSendable(makeThread({ scheduledMessage: null }), NOW)).toBe(false);
  });
});
