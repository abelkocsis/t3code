/**
 * When the composer offers its saved quick replies.
 *
 * The chips are an alternative to typing, so they show only while the draft is
 * empty and nothing else owns the space above the composer. A pending question
 * or approval answers through its own panel, and a reply sent into that panel
 * would be read as a custom answer rather than a message.
 */
export interface QuickRepliesVisibilityInput {
  readonly replyCount: number;
  readonly isDraftThread: boolean;
  readonly hasSendableContent: boolean;
  readonly hasPendingApproval: boolean;
  readonly pendingUserInputCount: number;
  readonly showPlanFollowUpPrompt: boolean;
  readonly isSendDisabled: boolean;
  readonly isComposerCollapsedMobile: boolean;
}

export function shouldShowQuickReplies(input: QuickRepliesVisibilityInput): boolean {
  if (input.replyCount === 0) return false;
  // A thread that has never run has nothing to say "go" to.
  if (input.isDraftThread) return false;
  if (input.hasSendableContent) return false;
  if (input.hasPendingApproval) return false;
  if (input.pendingUserInputCount > 0) return false;
  if (input.showPlanFollowUpPrompt) return false;
  if (input.isSendDisabled) return false;
  if (input.isComposerCollapsedMobile) return false;
  return true;
}
