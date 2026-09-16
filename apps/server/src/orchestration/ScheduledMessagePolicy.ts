import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

/**
 * Whether the sweep should send this thread's parked message now.
 *
 * The due time only opens the window. A busy thread keeps the message parked
 * until the work in front of it finishes, so a scheduled send never lands
 * mid-turn and never jumps an unanswered approval or question.
 */
export function isScheduledMessageSendable(thread: OrchestrationThreadShell, now: string): boolean {
  const scheduled = thread.scheduledMessage;
  if (scheduled == null || thread.archivedAt !== null) return false;
  const dueAt = Date.parse(scheduled.dueAt);
  if (Number.isNaN(dueAt) || dueAt > Date.parse(now)) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.backgroundLiveness != null) return false;
  return !threadHasQueuedTurnStart(thread, now);
}
