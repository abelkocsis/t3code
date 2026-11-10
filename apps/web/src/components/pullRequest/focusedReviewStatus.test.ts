import { expect, it } from "vite-plus/test";
import { focusedReviewStatus } from "./focusedReviewStatus";
it.each([
  [false, 0, 0, false, false, "Review pending", false],
  [true, 0, 0, false, false, "Review complete", true],
  [true, 1, 0, false, false, "Review issues outstanding", false],
  [true, 0, 1, false, false, "Review issues outstanding", false],
  [true, 0, null, false, false, "Comment assessment needed", false],
  [true, 0, 0, true, false, "Review assessment in progress", false],
  [true, 0, 0, false, true, "Review status unavailable", false],
] as const)(
  "derives review state for %j",
  (hasReview, unresolvedThreads, commentIssues, pending, unavailable, label, clear) => {
    expect(
      focusedReviewStatus({ hasReview, unresolvedThreads, commentIssues, pending, unavailable }),
    ).toEqual({ label, clear });
  },
);
