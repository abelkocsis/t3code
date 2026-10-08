import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  PullRequestActor,
  SlackThreadRef,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export type ShippingCategory =
  | "ready-to-merge"
  | "ready-for-re-review"
  | "ready-for-review"
  | "waiting"
  | "action-needed";

/** What still has to happen before a pull request in "action-needed" can go to a reviewer. */
export type ShippingProblem =
  | "conflicts"
  | "checks-failing"
  | "changes-requested"
  | "unresolved-comments"
  | "behind";

export const SHIPPING_PROBLEM_LABELS: Record<ShippingProblem, string> = {
  conflicts: "Conflicts",
  "checks-failing": "Checks failing",
  "changes-requested": "Changes requested",
  "unresolved-comments": "Unresolved comments",
  behind: "Branch out of date",
};

export interface ShippingItem {
  readonly thread: EnvironmentThreadShell;
  readonly link: ThreadPullRequestLink;
  readonly snapshot: ThreadPullRequestSnapshot;
  readonly category: ShippingCategory;
  readonly problems: ReadonlyArray<ShippingProblem>;
}

/**
 * Sorts one open, ready pull request by what it waits on. Problems come first, because a
 * reviewer asked to look at a red pull request is asked too early. Running checks wait next.
 * A pull request someone has reviewed goes back to that person; one nobody has reviewed is
 * ready for its first review.
 */
export function classifyShippingPullRequest(snapshot: ThreadPullRequestSnapshot): {
  readonly category: ShippingCategory;
  readonly problems: ReadonlyArray<ShippingProblem>;
} {
  const problems: ShippingProblem[] = [];
  if (snapshot.mergeability === "conflicting" || snapshot.mergeState === "dirty") {
    problems.push("conflicts");
  }
  if (snapshot.checksState === "failing") problems.push("checks-failing");
  if (snapshot.reviewDecision === "changes-requested") problems.push("changes-requested");
  if ((snapshot.unresolvedReviewThreads ?? 0) > 0) problems.push("unresolved-comments");
  if (snapshot.mergeState === "behind") problems.push("behind");
  if (problems.length > 0) return { category: "action-needed", problems };
  if (snapshot.checksState === "pending") return { category: "waiting", problems };
  // The summary counts a bot's approval too, so a green pull request GitHub still blocks is
  // waiting on a review its branch rules accept.
  if (snapshot.reviewDecision === "approved" && snapshot.mergeState !== "blocked") {
    return { category: "ready-to-merge", problems };
  }
  return {
    category: snapshot.lastReviewer ? "ready-for-re-review" : "ready-for-review",
    problems,
  };
}

/**
 * Every open, non-draft pull request the reader opened, linked to a thread that is not archived.
 * A host that does not say who opened it keeps the pull request rather than hiding it. A pull request
 * linked to several threads shows once, beside the thread that is still active, then the one
 * that linked it last.
 */
export function collectShippingItems(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ShippingItem> {
  const byKey = new Map<string, ShippingItem>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      const snapshot = link.snapshot;
      if (snapshot === null || snapshot.state !== "open" || snapshot.isDraft) continue;
      if (snapshot.viewerDidAuthor === false) continue;
      const key = `${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`;
      const existing = byKey.get(key);
      if (existing && !prefersThread(thread, link, existing)) continue;
      byKey.set(key, { thread, link, snapshot, ...classifyShippingPullRequest(snapshot) });
    }
  }
  return [...byKey.values()].toSorted((left, right) =>
    (right.snapshot.updatedAt ?? "").localeCompare(left.snapshot.updatedAt ?? ""),
  );
}

function prefersThread(
  thread: EnvironmentThreadShell,
  link: ThreadPullRequestLink,
  existing: ShippingItem,
): boolean {
  const settled = thread.settledAt !== null;
  const existingSettled = existing.thread.settledAt !== null;
  if (settled !== existingSettled) return !settled;
  return link.linkedAt > existing.link.linkedAt;
}

export type ShippingReviewGroup =
  | {
      readonly kind: "slack";
      readonly slackThread: SlackThreadRef;
      readonly items: ReadonlyArray<ShippingItem>;
    }
  | {
      readonly kind: "reviewer";
      readonly reviewer: PullRequestActor;
      readonly items: ReadonlyArray<ShippingItem>;
    }
  | { readonly kind: "unassigned"; readonly items: ReadonlyArray<ShippingItem> };

/**
 * A thread linked to a Slack thread sends its pull requests there, whoever reviewed them: that
 * conversation is where the review is happening. Otherwise re-reviews go back to whoever
 * reviewed last, and first reviews share one group, listed last.
 */
export function groupShippingReviews(
  items: ReadonlyArray<ShippingItem>,
): ReadonlyArray<ShippingReviewGroup> {
  const bySlackThread = new Map<string, { slackThread: SlackThreadRef; items: ShippingItem[] }>();
  const byReviewer = new Map<string, { reviewer: PullRequestActor; items: ShippingItem[] }>();
  const unassigned: ShippingItem[] = [];
  for (const item of items) {
    if (item.category !== "ready-for-re-review" && item.category !== "ready-for-review") continue;
    const slackThread = item.thread.slackThread ?? null;
    if (slackThread !== null) {
      const key = `${slackThread.channelId}/${slackThread.threadTs}`;
      const group = bySlackThread.get(key) ?? { slackThread, items: [] };
      group.items.push(item);
      bySlackThread.set(key, group);
      continue;
    }
    const reviewer = item.category === "ready-for-re-review" ? item.snapshot.lastReviewer : null;
    if (!reviewer) {
      unassigned.push(item);
      continue;
    }
    const key = reviewer.login.toLowerCase();
    const group = byReviewer.get(key) ?? { reviewer, items: [] };
    group.items.push(item);
    byReviewer.set(key, group);
  }
  return [
    ...[...bySlackThread.values()]
      .toSorted((left, right) =>
        left.slackThread.threadTs.localeCompare(right.slackThread.threadTs),
      )
      .map((group) => ({ kind: "slack" as const, ...group })),
    ...[...byReviewer.values()]
      .toSorted((left, right) => left.reviewer.login.localeCompare(right.reviewer.login))
      .map((group) => ({ kind: "reviewer" as const, ...group })),
    ...(unassigned.length > 0 ? [{ kind: "unassigned" as const, items: unassigned }] : []),
  ];
}

/** When the Slack message was posted, read from its timestamp, for the group's label. */
export function slackThreadPostedAt(slackThread: SlackThreadRef): Date {
  return new Date(Number(slackThread.threadTs.split(".")[0]) * 1000);
}

export function buildReviewRequestMessage(items: ReadonlyArray<ShippingItem>): string {
  return ["Please, review following PRs:", ...items.map((item) => `- ${item.link.url}`)].join("\n");
}
