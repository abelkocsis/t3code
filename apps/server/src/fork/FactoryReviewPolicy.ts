import type {
  FactoryPendingWork,
  FactoryPendingWorkPart,
  FactoryReviewMemo,
  OrchestrationV2ThreadShell,
  PullRequestActivity,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestReviewDecision,
  PullRequestState,
  ThreadFactory,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  FACTORY_PHASE_MARKER,
  FACTORY_SIGNING_RULE,
  FACTORY_IGNORE_CI_RULE,
  factoryHeldWorkMessage,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

/**
 * What the review sweep does to one task: update its factory state, send the agent a
 * message, or both. `null` means leave the task alone.
 */
export interface FactoryReviewDecision {
  readonly factory: ThreadFactory | null;
  readonly message: string | null;
}

/** The thread fields the sweep reads from upstream's shell. */
export type FactoryReviewThread = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "latestUserAuthoredMessageAt"
>;

/**
 * "dirty" has conflicts and "behind" needs a rebase; both mean: rebase onto the base.
 * "clean" merges as is. "unknown" is the host still computing.
 */
export type FactoryMergeState = "clean" | "behind" | "dirty" | "unknown";

/**
 * The pull request as the review stages see it, put together from the sync snapshot and
 * the host's detail and activity reads. The snapshot alone does not carry review ids or
 * open thread counts, so the sweep reads the host for a task in a review stage.
 */
export interface FactoryPullRequestView {
  readonly state: PullRequestState;
  readonly title: string;
  readonly baseBranch: string;
  readonly updatedAt: string | null;
  readonly checksState: PullRequestChecksState | null;
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly mergeState: FactoryMergeState | null;
  /** Absent when the activity could not be read: open threads stay as remembered. */
  readonly unresolvedReviewThreads?: number;
  /** The newest human review, by the host's id. Null: none. Absent: activity not read. */
  readonly lastReviewId?: string | null;
  /** The newest conversation comment by someone other than the author. Same convention. */
  readonly lastCommentId?: string | null;
}

export interface FactoryReviewTarget {
  readonly link: Pick<ThreadPullRequestLink, "url" | "host" | "repository" | "number">;
  readonly view: FactoryPullRequestView;
}

export interface FactoryReviewInput {
  readonly thread: FactoryReviewThread;
  readonly factory: ThreadFactory;
  readonly pullRequest: FactoryReviewTarget | null;
}

const EMPTY_MEMO: FactoryReviewMemo = {
  seenUpdatedAt: null,
  seenUnresolved: 0,
  seenChecksState: null,
  seenMergeState: null,
  seenReviewId: null,
  seenCommentId: null,
};

/** The pull request a task follows: an open one first, then a merged one, then any. */
export function factoryPullRequestLink(
  pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined,
): (ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot }) | null {
  const links = visibleThreadPullRequests(pullRequests ?? []);
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

function isBot(
  author: { readonly isBot?: boolean | undefined; readonly login: string } | null,
): boolean {
  return author?.isBot === true || /\[bot\]$/i.test(author?.login ?? "");
}

function checksStateOf(checks: PullRequestDetail["checks"]): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  if (
    checks.some(
      (check) =>
        check.status === "failure" ||
        check.status === "cancelled" ||
        check.status === "action-required",
    )
  ) {
    return "failing";
  }
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

function mergeStateOf(
  detail: Pick<PullRequestDetail, "mergeability" | "baseComparison" | "behindBy">,
): FactoryMergeState {
  if (detail.mergeability === "conflicting") return "dirty";
  if (detail.baseComparison === "behind" || (detail.behindBy ?? 0) > 0) return "behind";
  return detail.mergeability === "mergeable" ? "clean" : "unknown";
}

/**
 * Builds the review view. The snapshot gives the state the sync already tracks; the detail
 * gives the base comparison and the checks; the activity gives reviews, threads, and
 * comments. Without an activity read the review fields stay absent, so nothing fires on
 * them and nothing is forgotten.
 */
export function factoryPullRequestView(
  snapshot: ThreadPullRequestSnapshot,
  detail: Pick<
    PullRequestDetail,
    "state" | "title" | "baseBranch" | "updatedAt" | "checks" | "mergeability" | "author"
  > &
    Partial<Pick<PullRequestDetail, "baseComparison" | "behindBy">>,
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads" | "author"> | null,
): FactoryPullRequestView {
  const author = (activity?.author ?? detail.author)?.login.toLowerCase() ?? null;
  const byOthers = (comment: PullRequestActivity["comments"][number]) =>
    comment.author !== null &&
    !isBot(comment.author) &&
    comment.author.login.toLowerCase() !== author;
  const newest = (comments: ReadonlyArray<PullRequestActivity["comments"][number]>) =>
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)?.id ??
    null;
  return {
    state: detail.state,
    title: detail.title,
    baseBranch: detail.baseBranch,
    updatedAt: detail.updatedAt,
    checksState: snapshot.checksState ?? checksStateOf(detail.checks),
    reviewDecision: snapshot.reviewDecision ?? null,
    mergeState: mergeStateOf(detail),
    ...(activity === null
      ? {}
      : {
          unresolvedReviewThreads: activity.reviewThreads.filter((thread) => !thread.isResolved)
            .length,
          lastReviewId: newest(
            activity.comments.filter((comment) => comment.kind === "review" && byOthers(comment)),
          ),
          lastCommentId: newest(
            activity.comments.filter(
              (comment) => comment.kind === "issue-comment" && byOthers(comment),
            ),
          ),
        }),
  };
}

/**
 * A task back from review work keeps CI and its base watched: the agent may stop in "fix"
 * without a marker, or at a gate the human already answered in the thread.
 */
export function watchedAfterReview(thread: FactoryReviewThread, factory: ThreadFactory): boolean {
  if (factory.review == null) return false;
  if (factory.phase === "fix") return true;
  const answeredAt = thread.latestUserAuthoredMessageAt ?? null;
  return (
    factory.phase === "human-gate" &&
    answeredAt !== null &&
    DateTime.toEpochMillis(answeredAt) > Date.parse(factory.updatedAt)
  );
}

/** A message to the agent must not land mid-turn or jump an unanswered question. */
export function canMessageThread(thread: FactoryReviewThread): boolean {
  if (thread.archivedAt !== null) return false;
  if (
    thread.status === "preparing" ||
    thread.status === "queued" ||
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "waiting"
  ) {
    return false;
  }
  if (thread.pendingRuntimeRequest !== null) return false;
  return (thread.pendingBackgroundTasks ?? []).length === 0;
}

function isStaleBase(mergeState: string | null | undefined): boolean {
  return mergeState === "behind" || mergeState === "dirty";
}

function memoOf(
  view: FactoryPullRequestView,
  seenReviewId: string | null | undefined,
  seenCommentId: string | null | undefined,
): FactoryReviewMemo {
  return {
    seenUpdatedAt: view.updatedAt,
    seenUnresolved: view.unresolvedReviewThreads ?? 0,
    seenChecksState: view.checksState,
    seenMergeState: view.mergeState,
    ...(seenReviewId === undefined ? {} : { seenReviewId }),
    ...(seenCommentId === undefined ? {} : { seenCommentId }),
  };
}

function commentsMessage(link: FactoryReviewTarget["link"]): string {
  return [
    `New review activity on ${link.url}.`,
    "Read the new reviews, every open comment, the conversation comments, and the review decision. Decide for each one yourself: fix it on this branch, or push back with a reason. Pushing back is fine when the comment is wrong or out of scope. Do not ask me which ones to fix.",
    'Push the fixes. Then answer every comment on the pull request: a fixed one gets a reply that says "Resolved in commit <short sha>" and its conversation gets resolved; a declined one gets your reason and stays open.',
    `If you changed code, post a short report under the pull request: what you changed, what you declined, and which agents and models ran. Then print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
    `If nothing needs a change, print "${FACTORY_PHASE_MARKER} under-review" with one sentence.`,
    `If a comment needs a decision from me, print "${FACTORY_PHASE_MARKER} human-gate" and ask.`,
  ].join("\n");
}

function ciMessage(link: FactoryReviewTarget["link"]): string {
  return [
    `CI is failing on ${link.url}.`,
    "Find out whether this branch caused the failure. If it did, fix it on this branch and push.",
    `If the failure comes from elsewhere, or the fix is a big change, do not fix it here. Print "${FACTORY_PHASE_MARKER} human-gate" and ask me whether to open a new task for it, with a one-paragraph proposal.`,
    `When the branch is green again, print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
  ].join("\n");
}

function behindMessage(link: FactoryReviewTarget["link"], view: FactoryPullRequestView): string {
  return [
    `The base branch ${view.baseBranch} moved ahead of ${link.url}, or conflicts with it.`,
    "Rebase this branch onto the base branch, resolve conflicts, run the tests that cover the change, and push.",
    `If a conflict needs a decision from me, print "${FACTORY_PHASE_MARKER} human-gate" and ask.`,
    `When the branch is up to date, print "${FACTORY_PHASE_MARKER} ready-for-review" with one sentence.`,
  ].join("\n");
}

/** One message for several causes, so the agent handles them in one turn. */
function composeWork(parts: ReadonlyArray<FactoryPendingWorkPart>): {
  readonly summary: string;
  readonly message: string;
} {
  return {
    summary: parts.map((part) => part.summary).join(" "),
    message: [
      parts.length === 1
        ? parts[0]!.message
        : [
            "Several things need work on this pull request. Do all of them, then print one phase marker for the whole set.",
            ...parts.map((part, index) => `${index + 1}. ${part.message}`),
          ].join("\n\n"),
      FACTORY_SIGNING_RULE,
    ].join("\n\n"),
  };
}

/**
 * The causes held work is made of. Work held before parts existed is matched by its message;
 * null when it cannot be split.
 */
function heldParts(
  held: FactoryPendingWork,
  target: FactoryReviewTarget,
): ReadonlyArray<FactoryPendingWorkPart> | null {
  if (held.parts !== undefined) return held.parts;
  const cause =
    held.message === ciMessage(target.link)
      ? "ci"
      : held.message === behindMessage(target.link, target.view)
        ? "stale-base"
        : held.message === commentsMessage(target.link)
          ? "comments"
          : null;
  return cause === null ? null : [{ cause, summary: held.summary, message: held.message }];
}

/**
 * Held work loses a cause that cleared on its own: a check that passed on a rerun, or a base
 * someone else updated. Reviewer feedback stays until the agent answers it.
 */
function withoutClearedWork(factory: ThreadFactory, target: FactoryReviewTarget): ThreadFactory {
  const held = factory.pendingWork ?? null;
  const parts = held === null ? null : heldParts(held, target);
  if (parts === null) return factory;
  const left = parts.filter((part) =>
    part.cause === "ci"
      ? target.view.checksState === "failing"
      : part.cause === "stale-base"
        ? isStaleBase(target.view.mergeState)
        : true,
  );
  if (left.length === parts.length) return factory;
  if (left.length === 0) {
    return { ...factory, summary: "The held work cleared on its own.", pendingWork: null };
  }
  const work = composeWork(left);
  return {
    ...factory,
    summary: `${work.summary} Waiting for you to start it.`,
    pendingWork: { ...work, parts: left },
  };
}

/**
 * Moves a task through the review stages from its pull request, and tells the agent when
 * review work is needed. The human marks "under-review" and merges; this never merges.
 *
 * - A merged pull request ends the task as "merged"; a closed one as "done".
 * - "done" with a pull request becomes "ready-for-review".
 * - Ready for review: nobody reviews yet, so only a failed check or a stale base (behind or
 *   in conflict) becomes a message to the agent, and the phase goes to "fix".
 * - Under review: approval plus green checks on a clean branch with no open threads gives
 *   "ready-to-merge", even when the approval is new. Otherwise a human review or conversation
 *   comment the agent was not sent yet comes first. More open threads than before (a bot's
 *   review), a failed check, or a stale base become a message to the agent and the phase goes
 *   to "fix". Each cause fires once, and again only after it cleared.
 * - Ready to merge falls back to the under-review rules when the pull request changes.
 * - After the review stages, "fix" and an answered human gate keep the ready-for-review rules
 *   once the agent stops, so a push that breaks CI or falls behind the base is not missed.
 * - Token saving holds each message as `pendingWork` instead of sending it, and leaves the
 *   phase alone, so the task waits on the human. Turning token saving off sends held work, and
 *   the agent also checks the whole pull request, because it may have moved on meanwhile.
 *   A held failed check or stale base that clears on its own leaves the held work.
 */
export function decideFactoryReview(
  input: FactoryReviewInput,
  now: string,
  options: { readonly tokenSaving: boolean; readonly ignoreCi?: boolean } = { tokenSaving: false },
): FactoryReviewDecision | null {
  if (input.thread.archivedAt !== null) return null;
  const target = input.pullRequest;
  if (target === null) return null;
  // Treat CI as passing only inside this policy; the host result stays visible.
  const effectiveTarget = options.ignoreCi
    ? { ...target, view: { ...target.view, checksState: "passing" as const } }
    : target;
  const factory = withoutClearedWork(input.factory, effectiveTarget);
  return (
    decideWithFactory(input.thread, factory, effectiveTarget, now, options) ??
    (factory === input.factory ? null : { factory, message: null })
  );
}

function decideWithFactory(
  thread: FactoryReviewThread,
  factory: ThreadFactory,
  target: FactoryReviewTarget,
  now: string,
  options: { readonly tokenSaving: boolean; readonly ignoreCi?: boolean },
): FactoryReviewDecision | null {
  const { link, view } = target;
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

  // Held work ends with the task, and is moot once the pull request is approved and green.
  const dropHeld = (decision: FactoryReviewDecision): FactoryReviewDecision =>
    decision.factory?.pendingWork != null
      ? { ...decision, factory: { ...decision.factory, pendingWork: null } }
      : decision;

  if (view.state === "merged") {
    return factory.phase === "merged" ? null : dropHeld(stage("merged", "Pull request merged."));
  }
  if (view.state === "closed") {
    return factory.phase === "done"
      ? null
      : dropHeld(stage("done", "Pull request closed without a merge."));
  }
  const held = factory.pendingWork ?? null;
  if (held !== null && !options.tokenSaving) {
    if (!canMessageThread(thread)) return null;
    return {
      factory: {
        ...factory,
        phase: "fix",
        summary: held.summary,
        updatedAt: now,
        pendingWork: null,
      },
      message: factoryHeldWorkMessage(held, options.ignoreCi),
    };
  }
  // Holding replaces sending. Work already held is kept, so nothing found earlier is lost; a
  // cause found again replaces its older copy.
  const send = (
    decision: FactoryReviewDecision,
    parts: ReadonlyArray<FactoryPendingWorkPart>,
  ): FactoryReviewDecision | null => {
    if (!options.tokenSaving || decision.factory === null) {
      return canMessageThread(thread) ? decision : null;
    }
    const known = held === null ? [] : heldParts(held, target);
    // Old held work that cannot be split stays whole, as feedback, which never clears alone.
    const kept =
      known === null
        ? [{ cause: "comments" as const, summary: held!.summary, message: held!.message }]
        : known.filter((part) => !parts.some((added) => added.cause === part.cause));
    const merged = [...kept, ...parts];
    const work = composeWork(merged);
    return {
      factory: {
        ...decision.factory,
        phase: factory.phase,
        summary: `${work.summary} Waiting for you to start it.`,
        pendingWork: { ...work, parts: merged },
      },
      message: null,
    };
  };
  if (factory.phase === "done") {
    // A failure or stale base already there still counts, so the next sweep handles it, and
    // reviews already there go to the agent once the human marks the task under review.
    return stage("ready-for-review", view.title, {
      ...memoOf(view, null, null),
      seenChecksState: null,
      seenMergeState: null,
    });
  }
  const between = watchedAfterReview(thread, factory);
  if (
    !between &&
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
    memo.seenReviewId === undefined ? (view.lastReviewId ?? null) : memo.seenReviewId;
  const newReview = view.lastReviewId != null && view.lastReviewId !== seenReviewId;
  // The same for the newest conversation comment by someone other than the author.
  const seenCommentId =
    memo.seenCommentId === undefined ? (view.lastCommentId ?? null) : memo.seenCommentId;
  const newComment = view.lastCommentId != null && view.lastCommentId !== seenCommentId;
  const unresolved = view.unresolvedReviewThreads ?? memo.seenUnresolved;
  const newThreads = unresolved > memo.seenUnresolved;
  const newFailure = view.checksState === "failing" && memo.seenChecksState !== "failing";
  const newStaleBase = isStaleBase(view.mergeState) && !isStaleBase(memo.seenMergeState);
  // A cleared failure or stale base is forgotten, so the next one fires again. Fewer open
  // threads lower the count, so a thread opened after the agent resolved some counts as new.
  // The stage and its timestamp stay, so the task does not ask for attention again.
  const settled =
    (memo.seenChecksState === "failing" && view.checksState !== "failing") ||
    (isStaleBase(memo.seenMergeState) && !isStaleBase(view.mergeState)) ||
    unresolved < memo.seenUnresolved ||
    (memo.seenReviewId === undefined && view.lastReviewId !== undefined) ||
    (memo.seenCommentId === undefined && view.lastCommentId !== undefined);
  const settle = (): FactoryReviewDecision => ({
    factory: {
      ...factory,
      review: {
        ...memo,
        seenUnresolved: Math.min(memo.seenUnresolved, unresolved),
        seenChecksState: view.checksState,
        seenMergeState: view.mergeState,
        ...(view.lastReviewId === undefined ? {} : { seenReviewId }),
        ...(view.lastCommentId === undefined ? {} : { seenCommentId }),
      },
    },
    message: null,
  });

  // Every new cause goes out in one message. The memo marks them all as seen, so a cause left
  // out of the message would never be sent.
  const work = (input: {
    readonly comments: boolean;
    readonly seenReviewId: string | null | undefined;
    readonly seenCommentId: string | null | undefined;
  }) => {
    const parts: ReadonlyArray<FactoryPendingWorkPart> = [
      ...(newFailure
        ? [
            {
              cause: "ci" as const,
              summary: "CI failed; the agent is looking.",
              message: ciMessage(link),
            },
          ]
        : []),
      ...(newStaleBase
        ? [
            {
              cause: "stale-base" as const,
              summary: "Rebasing onto the base branch.",
              message: behindMessage(link, view),
            },
          ]
        : []),
      ...(input.comments
        ? [
            {
              cause: "comments" as const,
              summary: "Reading new review comments.",
              message: commentsMessage(link),
            },
          ]
        : []),
    ];
    const composed = composeWork(parts);

    return send(
      {
        ...stage("fix", composed.summary, memoOf(view, input.seenReviewId, input.seenCommentId)),
        message: options.ignoreCi
          ? `${composed.message}\n\n${FACTORY_IGNORE_CI_RULE}`
          : composed.message,
      },
      parts,
    );
  };

  if (factory.phase === "ready-for-review" || between) {
    if (!newFailure && !newStaleBase) return settled ? settle() : null;
    // A running agent may be on this very failure; it goes out once the agent stops.
    if (between && !canMessageThread(thread)) return null;
    return work({
      comments: false,
      seenReviewId: memo.seenReviewId,
      seenCommentId: memo.seenCommentId,
    });
  }

  const approved = view.reviewDecision === "approved";
  const green = view.checksState === "passing";
  const unblocked = view.mergeState === "clean";

  // A new review on an approved, green pull request with no open threads is the approval
  // itself, or a note on top of it, so it counts as seen and needs no agent turn.
  if (!newComment && approved && green && unblocked && unresolved === 0) {
    return factory.phase === "ready-to-merge" && !newReview
      ? null
      : dropHeld(
          stage(
            "ready-to-merge",
            options.ignoreCi ? "Approved; CI is ignored." : "Approved and green.",
            memoOf(view, view.lastReviewId ?? seenReviewId, seenCommentId),
          ),
        );
  }

  if (!newReview && !newComment && !newThreads && !newFailure && !newStaleBase) {
    // Ready to merge no longer holds, for example a new commit set checks back to pending.
    if (factory.phase === "ready-to-merge") {
      return stage(
        "under-review",
        "Waiting on checks or reviewers.",
        memoOf(view, seenReviewId, seenCommentId),
      );
    }
    return settled ? settle() : null;
  }
  const comments = newReview || newComment || newThreads;
  return work({
    comments,
    seenReviewId: comments ? (view.lastReviewId ?? seenReviewId) : seenReviewId,
    seenCommentId: comments ? (view.lastCommentId ?? seenCommentId) : seenCommentId,
  });
}
