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
  seenReviewId: null,
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

function memoOf(
  snapshot: ThreadPullRequestSnapshot,
  seenReviewId: string | null | undefined,
): FactoryReviewMemo {
  return {
    seenUpdatedAt: snapshot.updatedAt ?? null,
    seenUnresolved: snapshot.unresolvedReviewThreads ?? 0,
    seenChecksState: snapshot.checksState ?? null,
    seenMergeState: baseState(snapshot),
    ...(seenReviewId === undefined ? {} : { seenReviewId }),
  };
}

function commentsMessage(link: ThreadPullRequestLink): string {
  return [
    `New review activity on ${link.url}.`,
    "Read the new reviews, every open comment, and the review decision. Decide for each one yourself: fix it on this branch, or push back with a reason. Pushing back is fine when the comment is wrong or out of scope. Do not ask me which ones to fix.",
    'Push the fixes. Then answer every comment on the pull request: a fixed one gets a reply that says "Resolved in commit <short sha>" and its conversation gets resolved; a declined one gets your reason and stays open.',
    `If you changed code, post a short report under the pull request: what you changed, what you declined, and which agents and models ran. Then print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
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
 * - Under review: a human review the agent was not sent yet comes first, even an approval,
 *   because an approval can carry notes. Then approval plus green checks on an unblocked
 *   branch gives "ready-to-merge". More open threads than before (a bot's review), a failed
 *   check, or a stale base become a message to the agent and the phase goes to "fix". Each
 *   cause fires once, and again only after it cleared.
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
    // A failure or stale base already there still counts, so the next sweep handles it, and
    // reviews already there go to the agent once the human marks the task under review.
    return stage("ready-for-review", snapshot.title, {
      ...memoOf(snapshot, null),
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
  // The newest human review the agent was sent. A memo written before review ids existed
  // counts the current review as sent, so old reviews do not go out again.
  const seenReviewId =
    memo.seenReviewId === undefined ? (snapshot.lastReviewId ?? null) : memo.seenReviewId;
  const newReview = snapshot.lastReviewId != null && snapshot.lastReviewId !== seenReviewId;
  const unresolved = snapshot.unresolvedReviewThreads ?? 0;
  const newThreads = unresolved > memo.seenUnresolved;
  const newFailure = snapshot.checksState === "failing" && memo.seenChecksState !== "failing";
  const newStaleBase = isStaleBase(baseState(snapshot)) && !isStaleBase(memo.seenMergeState);
  // A cleared failure or stale base is forgotten, so the next one fires again. Fewer open
  // threads lower the count, so a thread opened after the agent resolved some counts as new.
  // The stage and its timestamp stay, so the task does not ask for attention again.
  const settled =
    (memo.seenChecksState === "failing" && snapshot.checksState !== "failing") ||
    (isStaleBase(memo.seenMergeState) && !isStaleBase(baseState(snapshot))) ||
    unresolved < memo.seenUnresolved ||
    (memo.seenReviewId === undefined && snapshot.lastReviewId !== undefined);
  const settle = (): FactoryReviewDecision => ({
    factory: {
      ...factory,
      review: {
        ...memo,
        seenUnresolved: Math.min(memo.seenUnresolved, unresolved),
        seenChecksState: snapshot.checksState ?? null,
        seenMergeState: baseState(snapshot),
        ...(snapshot.lastReviewId === undefined ? {} : { seenReviewId }),
      },
    },
    message: null,
  });

  if (factory.phase === "ready-for-review") {
    if (!newFailure && !newStaleBase) return settled ? settle() : null;
    if (!canMessageThread(thread, now)) return null;
    return newFailure
      ? {
          ...stage("fix", "CI failed; the agent is looking.", memoOf(snapshot, memo.seenReviewId)),
          message: ciMessage(link),
        }
      : {
          ...stage("fix", "Rebasing onto the base branch.", memoOf(snapshot, memo.seenReviewId)),
          message: behindMessage(link, snapshot),
        };
  }

  const approved = snapshot.reviewDecision === "approved";
  const green = snapshot.checksState === "passing";
  const unblocked =
    snapshot.mergeState === "clean" ||
    snapshot.mergeState === "has-hooks" ||
    snapshot.mergeState === "unstable";

  if (!newReview && approved && green && unblocked && unresolved === 0) {
    return factory.phase === "ready-to-merge"
      ? null
      : stage("ready-to-merge", "Approved and green.", memoOf(snapshot, seenReviewId));
  }

  if (!newReview && !newThreads && !newFailure && !newStaleBase) {
    // Ready to merge no longer holds, for example a new commit set checks back to pending.
    if (factory.phase === "ready-to-merge") {
      return stage(
        "under-review",
        "Waiting on checks or reviewers.",
        memoOf(snapshot, seenReviewId),
      );
    }
    return settled ? settle() : null;
  }
  if (!canMessageThread(thread, now)) return null;

  if (newFailure) {
    return {
      ...stage("fix", "CI failed; the agent is looking.", memoOf(snapshot, seenReviewId)),
      message: ciMessage(link),
    };
  }
  if (newStaleBase) {
    return {
      ...stage("fix", "Rebasing onto the base branch.", memoOf(snapshot, seenReviewId)),
      message: behindMessage(link, snapshot),
    };
  }
  return {
    ...stage(
      "fix",
      "Reading new review comments.",
      memoOf(snapshot, snapshot.lastReviewId ?? seenReviewId),
    ),
    message: commentsMessage(link),
  };
}
