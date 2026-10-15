import type {
  FactoryReviewMemo,
  OrchestrationThreadShell,
  ThreadFactory,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { FACTORY_PHASE_MARKER } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

/**
 * What the review sweep does to one thread: update its factory state, send the agent a
 * message, or both. `null` means leave the thread alone.
 */
export interface FactoryReviewDecision {
  readonly factory: ThreadFactory | null;
  readonly message: string | null;
}

const EMPTY_MEMO: FactoryReviewMemo = {
  seenUpdatedAt: null,
  seenUnresolved: 0,
  seenChecksState: null,
  seenMergeState: null,
};

/** The pull request a task follows: an open one first, then a merged one, then any. */
export function factoryPullRequest(
  thread: Pick<OrchestrationThreadShell, "pullRequests">,
): (ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot }) | null {
  const links = visibleThreadPullRequests(thread.pullRequests);
  const withSnapshot = links.filter(
    (link): link is ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot } =>
      link.snapshot !== null,
  );
  return (
    withSnapshot.find((link) => link.snapshot.state === "open") ??
    withSnapshot.find((link) => link.snapshot.state === "merged") ??
    withSnapshot[0] ??
    null
  );
}

/** A message to the agent must not land mid-turn or jump an unanswered question. */
export function canMessageThread(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.archivedAt !== null) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.backgroundLiveness != null) return false;
  return !threadHasQueuedTurnStart(thread, now);
}

/** Behind needs a rebase to merge; dirty has conflicts. Both mean: rebase onto the base. */
function isStaleBase(mergeState: FactoryReviewMemo["seenMergeState"] | undefined): boolean {
  return mergeState === "behind" || mergeState === "dirty";
}

/**
 * The merge state with "behind" filled in from the base comparison. GitHub reports BEHIND only
 * where the repository requires an up-to-date branch; elsewhere a branch the base moved ahead of
 * still reads as clean or blocked.
 */
function baseState(snapshot: ThreadPullRequestSnapshot): FactoryReviewMemo["seenMergeState"] {
  if (snapshot.canUpdateBranch === true && snapshot.mergeState !== "dirty") return "behind";
  return snapshot.mergeState ?? null;
}

function memoOf(snapshot: ThreadPullRequestSnapshot): FactoryReviewMemo {
  return {
    seenUpdatedAt: snapshot.updatedAt ?? null,
    seenUnresolved: snapshot.unresolvedReviewThreads ?? 0,
    seenChecksState: snapshot.checksState ?? null,
    seenMergeState: baseState(snapshot),
  };
}

function commentsMessage(link: ThreadPullRequestLink): string {
  return [
    `New review activity on ${link.url}.`,
    "Read every open comment and the review decision. Decide for each one yourself: fix it on this branch, or push back with a reason. Pushing back is fine when the comment is wrong or out of scope. Do not ask me which ones to fix.",
    'Push the fixes. Then answer every comment on the pull request: a fixed one gets a reply that says "Resolved in commit <short sha>" and its conversation gets resolved; a declined one gets your reason and stays open.',
    "Post a short report under the pull request: what you changed, what you declined, and which agents and models ran.",
    `When you are done, print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
    `If a comment needs a decision from me, print "${FACTORY_PHASE_MARKER} human-gate" and ask.`,
  ].join("\n");
}

function existingReviewsMessage(link: ThreadPullRequestLink): string {
  return [
    `I marked ${link.url} as under review. It already has reviews.`,
    "Before anything else, read every review, every open comment, and the review decision. Decide for each one yourself: fix it on this branch, or push back with a reason. Do not ask me which ones to fix.",
    'Push the fixes. Then answer every comment on the pull request: a fixed one gets a reply that says "Resolved in commit <short sha>" and its conversation gets resolved; a declined one gets your reason and stays open.',
    `If you changed code, post a short report under the pull request and print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
    `If nothing needs a change, print "${FACTORY_PHASE_MARKER} under-review" with one sentence.`,
    `If a comment needs a decision from me, print "${FACTORY_PHASE_MARKER} human-gate" and ask.`,
  ].join("\n");
}

function ciMessage(link: ThreadPullRequestLink): string {
  return [
    `CI is failing on ${link.url}.`,
    "Find out whether this branch caused the failure. If it did, fix it on this branch and push.",
    `If the failure comes from elsewhere, or the fix is a big change, do not fix it here. Print "${FACTORY_PHASE_MARKER} human-gate" and ask me whether to open a new task for it, with a one-paragraph proposal.`,
    `When the branch is green again, print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
  ].join("\n");
}

function behindMessage(link: ThreadPullRequestLink, snapshot: ThreadPullRequestSnapshot): string {
  return [
    `The base branch ${snapshot.baseBranch} moved ahead of ${link.url}, or conflicts with it.`,
    "Rebase this branch onto the base branch, resolve conflicts, run the tests that cover the change, and push.",
    `If a conflict needs a decision from me, print "${FACTORY_PHASE_MARKER} human-gate" and ask.`,
    `When the branch is up to date, print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
  ].join("\n");
}

/**
 * Moves a task through the review stages from its pull request, and tells the agent when
 * review work is needed. The human marks "under-review" and merges; this never merges.
 *
 * - A thread without factory state is left alone: threads join the factory only by hand.
 * - A merged pull request ends the task as "merged"; a closed one as "done".
 * - "done" with a pull request becomes "ready-for-review".
 * - Ready for review: nobody reviews yet, so only a failed check or a stale base (behind or
 *   in conflict) becomes a message to the agent, and the phase goes to "fix".
 * - Just marked under review: reviews already on the pull request go to the agent first.
 * - Under review: approval plus green checks on an unblocked branch gives "ready-to-merge".
 *   New comments, a failed check, or a stale base become a message to the agent and the
 *   phase goes to "fix". Each cause fires once, and again only after it cleared.
 * - Ready to merge falls back to the under-review rules when the pull request changes.
 */
export function decideFactoryReview(
  thread: OrchestrationThreadShell,
  now: string,
): FactoryReviewDecision | null {
  if (thread.archivedAt !== null) return null;
  const link = factoryPullRequest(thread);
  const factory = thread.factory ?? null;

  if (!factory || !link) return null;
  const snapshot = link.snapshot;
  const stage = (phase: ThreadFactory["phase"], summary: string | null, memo?: FactoryReviewMemo) =>
    ({
      factory: {
        ...factory,
        phase,
        summary,
        updatedAt: now,
        ...(memo ? { review: memo } : {}),
      },
      message: null,
    }) satisfies FactoryReviewDecision;

  if (snapshot.state === "merged") {
    return factory.phase === "merged" ? null : stage("merged", "Pull request merged.");
  }
  if (snapshot.state === "closed") {
    return factory.phase === "done" ? null : stage("done", "Pull request closed without a merge.");
  }
  if (factory.phase === "done") {
    // A failure or stale base already there still counts, so the next sweep handles it.
    return stage("ready-for-review", snapshot.title, {
      ...memoOf(snapshot),
      seenChecksState: null,
      seenMergeState: null,
    });
  }
  if (
    factory.phase !== "ready-for-review" &&
    factory.phase !== "under-review" &&
    factory.phase !== "ready-to-merge"
  ) {
    return null;
  }

  const memo = factory.review ?? EMPTY_MEMO;
  const newFailure = snapshot.checksState === "failing" && memo.seenChecksState !== "failing";
  const newStaleBase = isStaleBase(baseState(snapshot)) && !isStaleBase(memo.seenMergeState);
  // A cleared failure or stale base is forgotten, so the next one fires again. The stage and
  // its timestamp stay, so the task does not ask for attention again.
  const cleared =
    (memo.seenChecksState === "failing" && snapshot.checksState !== "failing") ||
    (isStaleBase(memo.seenMergeState) && !isStaleBase(baseState(snapshot)));
  const forgetCleared = (): FactoryReviewDecision => ({
    factory: {
      ...factory,
      review: {
        ...memo,
        seenChecksState: snapshot.checksState ?? null,
        seenMergeState: baseState(snapshot),
      },
    },
    message: null,
  });

  if (factory.phase === "ready-for-review") {
    if (!newFailure && !newStaleBase) return cleared ? forgetCleared() : null;
    if (!canMessageThread(thread, now)) return null;
    return newFailure
      ? {
          ...stage("fix", "CI failed; the agent is looking.", memoOf(snapshot)),
          message: ciMessage(link),
        }
      : {
          ...stage("fix", "Rebasing onto the base branch.", memoOf(snapshot)),
          message: behindMessage(link, snapshot),
        };
  }

  // "Mark under review" clears seenUpdatedAt. Reviews already on the pull request then come
  // first, even an approval, because an approval can still carry comments.
  const justMarked = factory.phase === "under-review" && memo.seenUpdatedAt === null;
  const hasReviews =
    snapshot.lastReviewer != null ||
    snapshot.reviewDecision === "changes-requested" ||
    (snapshot.unresolvedReviewThreads ?? 0) > 0;
  if (justMarked && hasReviews) {
    if (!canMessageThread(thread, now)) return null;
    return {
      ...stage("fix", "Reading the reviews already on the pull request.", memoOf(snapshot)),
      message: existingReviewsMessage(link),
    };
  }

  const changed = (snapshot.updatedAt ?? null) !== memo.seenUpdatedAt;
  const approved = snapshot.reviewDecision === "approved";
  const green = snapshot.checksState === "passing";
  const unblocked =
    snapshot.mergeState === "clean" ||
    snapshot.mergeState === "has-hooks" ||
    snapshot.mergeState === "unstable";

  if (approved && green && unblocked && (snapshot.unresolvedReviewThreads ?? 0) === 0) {
    return factory.phase === "ready-to-merge"
      ? null
      : stage("ready-to-merge", "Approved and green.", memoOf(snapshot));
  }

  const needsWork =
    (changed &&
      (snapshot.reviewDecision === "changes-requested" ||
        (snapshot.unresolvedReviewThreads ?? 0) > memo.seenUnresolved)) ||
    newFailure ||
    newStaleBase;
  if (!needsWork) {
    // Ready to merge no longer holds, for example a new commit set checks back to pending.
    if (factory.phase === "ready-to-merge") {
      return stage("under-review", "Waiting on checks or reviewers.", memoOf(snapshot));
    }
    return cleared ? forgetCleared() : null;
  }
  if (!canMessageThread(thread, now)) return null;

  const message = newFailure
    ? ciMessage(link)
    : newStaleBase
      ? behindMessage(link, snapshot)
      : commentsMessage(link);
  const summary =
    message === commentsMessage(link)
      ? "Reading new review comments."
      : snapshot.checksState === "failing"
        ? "CI failed; the agent is looking."
        : "Rebasing onto the base branch.";
  return { ...stage("fix", summary, memoOf(snapshot)), message };
}
