export function focusedReviewStatus(input: {
  hasReview: boolean;
  unresolvedThreads: number;
  commentIssues: number | null;
  pending: boolean;
  unavailable: boolean;
}) {
  if (input.pending) return { clear: false, label: "Review assessment in progress" };
  if (input.unavailable) return { clear: false, label: "Review status unavailable" };
  if (!input.hasReview) return { clear: false, label: "Review pending" };
  if (input.commentIssues === null) return { clear: false, label: "Comment assessment needed" };
  if (input.unresolvedThreads > 0 || input.commentIssues > 0)
    return { clear: false, label: "Review issues outstanding" };
  return { clear: true, label: "Review complete" };
}
