import { describe, expect, it } from "vite-plus/test";

import {
  offeredQuickReplies,
  shouldShowQuickReplies,
  type QuickRepliesVisibilityInput,
} from "./quickReplyVisibility";

const visible: QuickRepliesVisibilityInput = {
  replyCount: 4,
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

  it("hides them when sending is blocked", () => {
    expect(shouldShowQuickReplies({ ...visible, isSendDisabled: true })).toBe(false);
  });

  it("hides them when the user has emptied the list", () => {
    expect(shouldShowQuickReplies({ ...visible, replyCount: 0 })).toBe(false);
  });
});

describe("offeredQuickReplies", () => {
  const go = { id: "go", label: "Go", text: "go" };
  const review = { id: "review", label: "Review", text: "review the diff", showInNewThread: true };

  it("offers every reply on a thread that has run", () => {
    expect(offeredQuickReplies([go, review], false)).toEqual([go, review]);
  });

  it("offers only the replies marked for new threads on a thread that has never run", () => {
    expect(offeredQuickReplies([go, review], true)).toEqual([review]);
    expect(offeredQuickReplies([go], true)).toEqual([]);
  });
});
