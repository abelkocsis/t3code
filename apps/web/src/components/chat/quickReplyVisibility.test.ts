import { describe, expect, it } from "vite-plus/test";

import { shouldShowQuickReplies, type QuickRepliesVisibilityInput } from "./quickReplyVisibility";

const visible: QuickRepliesVisibilityInput = {
  replyCount: 4,
  isDraftThread: false,
  hasSendableContent: false,
  hasPendingApproval: false,
  pendingUserInputCount: 0,
  showPlanFollowUpPrompt: false,
  isSendDisabled: false,
  isComposerCollapsedMobile: false,
};

describe("shouldShowQuickReplies", () => {
  it("offers the chips on a settled thread with an empty draft", () => {
    expect(shouldShowQuickReplies(visible)).toBe(true);
  });

  it("hides them as soon as the draft holds something to send", () => {
    expect(shouldShowQuickReplies({ ...visible, hasSendableContent: true })).toBe(false);
  });

  it("hides them while a question or an approval owns the answer", () => {
    expect(shouldShowQuickReplies({ ...visible, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowQuickReplies({ ...visible, hasPendingApproval: true })).toBe(false);
    expect(shouldShowQuickReplies({ ...visible, showPlanFollowUpPrompt: true })).toBe(false);
  });

  it("hides them on a thread that has never run, and when sending is blocked", () => {
    expect(shouldShowQuickReplies({ ...visible, isDraftThread: true })).toBe(false);
    expect(shouldShowQuickReplies({ ...visible, isSendDisabled: true })).toBe(false);
  });

  it("hides them when the user has emptied the list", () => {
    expect(shouldShowQuickReplies({ ...visible, replyCount: 0 })).toBe(false);
  });
});
