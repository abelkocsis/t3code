import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ThreadFactory,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideFactoryReview } from "./FactoryReviewPolicy.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const EARLIER = "2026-10-14T11:00:00.000Z";

function snapshot(overrides: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Record purges in the audit trail",
    headBranch: "feature/purge-audit",
    baseBranch: "main",
    isDraft: false,
    updatedAt: EARLIER,
    syncedAt: EARLIER,
    reviewDecision: "review-required",
    checksState: "pending",
    mergeability: "mergeable",
    mergeState: "blocked",
    unresolvedReviewThreads: 0,
    viewerDidAuthor: true,
    ...overrides,
  };
}

function link(overrides: Partial<ThreadPullRequestSnapshot> | null = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "dlc-link/decentralization-manager",
    number: 541,
    url: "https://github.com/DLC-link/decentralization-manager/pull/541",
    source: "created",
    linkedAt: EARLIER,
    snapshot: overrides === null ? null : snapshot(overrides),
    stack: null,
  };
}

function factory(overrides: Partial<ThreadFactory> = {}): ThreadFactory {
  return {
    input: {
      kind: "github-issue",
      value: "https://github.com/DLC-link/decentralization-manager/issues/532",
    },
    phase: "under-review",
    summary: null,
    startedAt: EARLIER,
    updatedAt: EARLIER,
    review: {
      seenUpdatedAt: EARLIER,
      seenUnresolved: 0,
      seenChecksState: "pending",
      seenMergeState: "blocked",
      seenReviewId: null,
      seenCommentId: null,
    },
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Issue #532",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [link()],
    latestTurn: null,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    factory: factory(),
    ...overrides,
  };
}

describe("decideFactoryReview", () => {
  it("never enrols a thread on its own, even with the user's own open pull request", () => {
    expect(decideFactoryReview(thread({ factory: null }), NOW)).toBeNull();
    expect(decideFactoryReview(thread({ factory: null, pullRequests: [] }), NOW)).toBeNull();
  });

  it("moves a done task with a pull request to ready for review", () => {
    const decision = decideFactoryReview(
      thread({ factory: factory({ phase: "done", review: null }) }),
      NOW,
    );
    expect(decision?.factory?.phase).toBe("ready-for-review");
    expect(decision?.factory?.review?.seenUpdatedAt).toBe(EARLIER);
  });

  it("does not touch a task the agent still runs", () => {
    expect(
      decideFactoryReview(thread({ factory: factory({ phase: "implementation" }) }), NOW),
    ).toBeNull();
    expect(
      decideFactoryReview(thread({ factory: factory({ phase: "ready-for-review" }) }), NOW),
    ).toBeNull();
  });

  it("ends the task when the pull request merges or closes", () => {
    expect(
      decideFactoryReview(thread({ pullRequests: [link({ state: "merged" })] }), NOW)?.factory
        ?.phase,
    ).toBe("merged");
    expect(
      decideFactoryReview(thread({ pullRequests: [link({ state: "closed" })] }), NOW)?.factory
        ?.phase,
    ).toBe("done");
  });

  it("marks ready to merge on approval with green checks", () => {
    const decision = decideFactoryReview(
      thread({
        pullRequests: [
          link({ reviewDecision: "approved", checksState: "passing", mergeState: "clean" }),
        ],
      }),
      NOW,
    );
    expect(decision?.factory?.phase).toBe("ready-to-merge");
    expect(decision?.message).toBeNull();
  });

  it("sends a stale base together with new review comments, so the rebase is not lost", () => {
    const decision = decideFactoryReview(
      thread({
        pullRequests: [link({ lastReviewId: "PRR_2", canUpdateBranch: true })],
      }),
      NOW,
    );
    expect(decision?.message).toContain("Several things need work");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.message).toContain("Rebase this branch onto the base branch");
    expect(decision?.factory?.summary).toBe(
      "Rebasing onto the base branch. Reading new review comments.",
    );
  });

  it("holds a stale base and new comments as one piece of work under token saving", () => {
    const decision = decideFactoryReview(
      thread({
        pullRequests: [link({ lastReviewId: "PRR_2", canUpdateBranch: true })],
      }),
      NOW,
      { tokenSaving: true },
    );
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.pendingWork?.message).toContain("Rebase this branch");
    expect(decision?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("asks the agent to handle a new human review once", () => {
    const changed = thread({
      pullRequests: [
        link({
          updatedAt: NOW,
          reviewDecision: "changes-requested",
          lastReviewId: "PRR_2",
          unresolvedReviewThreads: 2,
        }),
      ],
    });
    const decision = decideFactoryReview(changed, NOW);
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.factory?.review).toMatchObject({ seenReviewId: "PRR_2", seenUnresolved: 2 });

    const seen = thread({
      ...changed,
      factory: { ...factory(), phase: "under-review", review: decision!.factory!.review! },
    });
    expect(decideFactoryReview(seen, NOW)).toBeNull();
  });

  it("does not resend a handled review or the threads the agent declined", () => {
    // The agent fixed one comment, declined two, and the human marked the task again.
    const marked = factory({
      reviewRound: 2,
      review: {
        seenUpdatedAt: NOW,
        seenUnresolved: 2,
        seenChecksState: "passing",
        seenMergeState: "blocked",
        seenReviewId: "PRR_1",
      },
    });
    const pullRequest = link({
      updatedAt: NOW,
      reviewDecision: "changes-requested",
      checksState: "passing",
      lastReviewId: "PRR_1",
      unresolvedReviewThreads: 2,
    });
    expect(
      decideFactoryReview(thread({ factory: marked, pullRequests: [pullRequest] }), NOW),
    ).toBeNull();
  });

  it("sends a review that came before the first review round, even an approval", () => {
    const decision = decideFactoryReview(
      thread({
        pullRequests: [
          link({
            lastReviewId: "PRR_1",
            reviewDecision: "approved",
            checksState: "passing",
            mergeState: "clean",
          }),
        ],
      }),
      NOW,
    );
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
  });

  it("counts a new thread after the agent resolved some", () => {
    const resolved = decideFactoryReview(
      thread({
        factory: factory({
          review: {
            seenUpdatedAt: EARLIER,
            seenUnresolved: 3,
            seenChecksState: "pending",
            seenMergeState: "blocked",
            seenReviewId: null,
          },
        }),
        pullRequests: [link({ unresolvedReviewThreads: 1 })],
      }),
      NOW,
    );
    expect(resolved?.message).toBeNull();
    expect(resolved?.factory?.review?.seenUnresolved).toBe(1);

    const opened = decideFactoryReview(
      thread({
        factory: { ...factory(), review: resolved!.factory!.review! },
        pullRequests: [link({ unresolvedReviewThreads: 2 })],
      }),
      NOW,
    );
    expect(opened?.message).toContain("New review activity");
  });

  it("asks the agent to answer a new conversation comment once", () => {
    const commented = thread({ pullRequests: [link({ updatedAt: NOW, lastCommentId: "IC_1" })] });
    const decision = decideFactoryReview(commented, NOW);
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.factory?.review?.seenCommentId).toBe("IC_1");

    const seen = thread({
      ...commented,
      factory: { ...factory(), review: decision!.factory!.review! },
    });
    expect(decideFactoryReview(seen, NOW)).toBeNull();
  });

  it("does not mark ready to merge over a conversation comment the agent was not sent", () => {
    const decision = decideFactoryReview(
      thread({
        pullRequests: [
          link({
            reviewDecision: "approved",
            checksState: "passing",
            mergeState: "clean",
            lastCommentId: "IC_1",
          }),
        ],
      }),
      NOW,
    );
    expect(decision?.factory?.phase).toBe("fix");
  });

  it("treats the current comment as handled on a memo from before comment ids", () => {
    const { seenCommentId: _, ...oldMemo } = factory().review!;
    const decision = decideFactoryReview(
      thread({
        factory: factory({ review: oldMemo }),
        pullRequests: [link({ lastCommentId: "IC_1" })],
      }),
      NOW,
    );
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.review?.seenCommentId).toBe("IC_1");
  });

  it("treats the current review as handled on a memo from before review ids", () => {
    const { seenReviewId: _, ...oldMemo } = factory().review!;
    const decision = decideFactoryReview(
      thread({
        factory: factory({ review: oldMemo }),
        pullRequests: [link({ lastReviewId: "PRR_1" })],
      }),
      NOW,
    );
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.review?.seenReviewId).toBe("PRR_1");
  });

  it("asks the agent to look at a failed check and a stale base once each", () => {
    const failing = decideFactoryReview(
      thread({ pullRequests: [link({ checksState: "failing" })] }),
      NOW,
    );
    expect(failing?.message).toContain("CI is failing");
    expect(failing?.factory?.review?.seenChecksState).toBe("failing");

    const behind = decideFactoryReview(
      thread({ pullRequests: [link({ mergeState: "behind" })] }),
      NOW,
    );
    expect(behind?.message).toContain("moved ahead");
    expect(behind?.factory?.review?.seenMergeState).toBe("behind");
  });

  it("keeps a task ready for review rebased and green", () => {
    const readyForReview = factory({ phase: "ready-for-review" });
    const conflicts = decideFactoryReview(
      thread({ factory: readyForReview, pullRequests: [link({ mergeState: "dirty" })] }),
      NOW,
    );
    expect(conflicts?.factory?.phase).toBe("fix");
    expect(conflicts?.message).toContain("Rebase this branch");

    const failing = decideFactoryReview(
      thread({ factory: readyForReview, pullRequests: [link({ checksState: "failing" })] }),
      NOW,
    );
    expect(failing?.factory?.phase).toBe("fix");
    expect(failing?.message).toContain("CI is failing");

    // Nobody reviews yet, so comments wait until the task is under review.
    const comments = decideFactoryReview(
      thread({
        factory: readyForReview,
        pullRequests: [link({ updatedAt: NOW, unresolvedReviewThreads: 2 })],
      }),
      NOW,
    );
    expect(comments).toBeNull();
  });

  it("rebases when the base moved ahead on a repository that does not report behind", () => {
    const decision = decideFactoryReview(
      thread({
        factory: factory({ phase: "ready-for-review" }),
        pullRequests: [link({ mergeState: "blocked", canUpdateBranch: true })],
      }),
      NOW,
    );
    expect(decision?.message).toContain("Rebase this branch");
    expect(decision?.factory?.review?.seenMergeState).toBe("behind");
  });

  it("fires again for a failure that cleared and came back", () => {
    const seenFailing = factory({
      phase: "ready-for-review",
      summary: "Ready.",
      review: {
        seenUpdatedAt: EARLIER,
        seenUnresolved: 0,
        seenChecksState: "failing",
        seenMergeState: "dirty",
      },
    });
    expect(
      decideFactoryReview(
        thread({
          factory: seenFailing,
          pullRequests: [link({ checksState: "failing", mergeState: "dirty" })],
        }),
        NOW,
      ),
    ).toBeNull();

    const cleared = decideFactoryReview(
      thread({
        factory: seenFailing,
        pullRequests: [link({ checksState: "passing", mergeState: "blocked" })],
      }),
      NOW,
    );
    expect(cleared?.message).toBeNull();
    expect(cleared?.factory?.phase).toBe("ready-for-review");
    expect(cleared?.factory?.updatedAt).toBe(EARLIER);
    expect(cleared?.factory?.review?.seenChecksState).toBe("passing");

    const again = decideFactoryReview(
      thread({
        factory: cleared!.factory!,
        pullRequests: [link({ checksState: "failing" })],
      }),
      NOW,
    );
    expect(again?.message).toContain("CI is failing");
  });

  it("handles a failure already present when the task becomes ready for review", () => {
    const done = decideFactoryReview(
      thread({
        factory: factory({ phase: "done", review: null }),
        pullRequests: [link({ mergeState: "dirty" })],
      }),
      NOW,
    );
    const next = decideFactoryReview(
      thread({ factory: done!.factory!, pullRequests: [link({ mergeState: "dirty" })] }),
      NOW,
    );
    expect(next?.message).toContain("Rebase this branch");
  });

  it("waits with the message while the agent is busy or a question is open", () => {
    const busy = thread({
      pullRequests: [link({ checksState: "failing" })],
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "claude",
        runtimeMode: "full-access",
        activeTurnId: null,
        updatedAt: EARLIER,
        lastError: null,
      },
    });
    expect(decideFactoryReview(busy, NOW)).toBeNull();
    const asking = thread({
      pullRequests: [link({ checksState: "failing" })],
      hasPendingUserInput: true,
    });
    expect(decideFactoryReview(asking, NOW)).toBeNull();
  });

  it("drops ready to merge back to under review when the pull request changes", () => {
    const decision = decideFactoryReview(
      thread({
        factory: factory({ phase: "ready-to-merge" }),
        pullRequests: [link({ updatedAt: NOW, checksState: "pending" })],
      }),
      NOW,
    );
    expect(decision?.factory?.phase).toBe("under-review");
    expect(decision?.message).toBeNull();
  });
});

describe("decideFactoryReview with token saving", () => {
  const SAVING = { tokenSaving: true };

  it("holds review work instead of messaging the agent, and keeps the phase", () => {
    const decision = decideFactoryReview(
      thread({ pullRequests: [link({ checksState: "failing" })] }),
      NOW,
      SAVING,
    );
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.phase).toBe("under-review");
    expect(decision?.factory?.pendingWork?.message).toContain("CI is failing");
    expect(decision?.factory?.review?.seenChecksState).toBe("failing");
  });

  it("holds work while the agent is busy, since nothing is sent", () => {
    const decision = decideFactoryReview(
      thread({ pullRequests: [link({ mergeState: "behind" })], hasPendingUserInput: true }),
      NOW,
      SAVING,
    );
    expect(decision?.factory?.pendingWork?.message).toContain("moved ahead");
  });

  it("holds a stale base and a new conversation comment as one piece of work", () => {
    const decision = decideFactoryReview(
      thread({ pullRequests: [link({ lastCommentId: "IC_1", canUpdateBranch: true })] }),
      NOW,
      SAVING,
    );
    expect(decision?.factory?.pendingWork?.message).toContain("Rebase this branch");
    expect(decision?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("adds new work to work already held", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    const decision = decideFactoryReview(
      thread({
        factory: held,
        pullRequests: [
          link({ updatedAt: NOW, reviewDecision: "changes-requested", unresolvedReviewThreads: 1 }),
        ],
      }),
      NOW,
      SAVING,
    );
    expect(decision?.factory?.pendingWork?.message).toContain("CI is failing on the branch.");
    expect(decision?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("sends held work once token saving is off and the agent is free", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    const decision = decideFactoryReview(thread({ factory: held }), NOW);
    expect(decision?.message).toMatch(/^CI is failing on the branch\./);
    // The work waited, so the agent also checks the whole pull request.
    expect(decision?.message).toContain("Rebase onto the base branch if it moved ahead");
    expect(decision?.message).toContain("conversation comment");
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.factory?.pendingWork).toBeNull();

    const busy = thread({ factory: held, hasPendingUserInput: true });
    expect(decideFactoryReview(busy, NOW)).toBeNull();
  });

  it("drops a held CI failure that passed on a rerun", () => {
    const failed = decideFactoryReview(
      thread({ pullRequests: [link({ checksState: "failing" })] }),
      NOW,
      SAVING,
    )!.factory!;
    const rerun = decideFactoryReview(
      thread({ factory: failed, pullRequests: [link({ checksState: "pending" })] }),
      NOW,
      SAVING,
    );
    expect(rerun?.message).toBeNull();
    expect(rerun?.factory?.pendingWork).toBeNull();
    expect(rerun?.factory?.updatedAt).toBe(failed.updatedAt);

    // Work held before parts existed is matched by its message.
    const { parts: _, ...legacy } = failed.pendingWork!;
    const legacyRerun = decideFactoryReview(
      thread({
        factory: { ...failed, pendingWork: legacy },
        pullRequests: [link({ checksState: "passing" })],
      }),
      NOW,
      SAVING,
    );
    expect(legacyRerun?.factory?.pendingWork).toBeNull();
  });

  it("keeps held review feedback when the held CI failure clears", () => {
    const held = decideFactoryReview(
      thread({ pullRequests: [link({ checksState: "failing", lastCommentId: "IC_1" })] }),
      NOW,
      SAVING,
    )!.factory!;
    expect(held.pendingWork?.parts?.map((part) => part.cause)).toEqual(["ci", "comments"]);

    const cleared = decideFactoryReview(
      thread({
        factory: held,
        pullRequests: [link({ checksState: "passing", lastCommentId: "IC_1" })],
      }),
      NOW,
      SAVING,
    );
    expect(cleared?.factory?.pendingWork?.parts?.map((part) => part.cause)).toEqual(["comments"]);
    expect(cleared?.factory?.pendingWork?.message).not.toContain("CI is failing");
    expect(cleared?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("drops a held rebase once the branch is up to date", () => {
    const behind = decideFactoryReview(
      thread({ pullRequests: [link({ mergeState: "behind" })] }),
      NOW,
      SAVING,
    )!.factory!;
    const updated = decideFactoryReview(
      thread({ factory: behind, pullRequests: [link({ mergeState: "blocked" })] }),
      NOW,
      SAVING,
    );
    expect(updated?.factory?.pendingWork).toBeNull();
  });

  it("keeps old held work it cannot split", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    expect(
      decideFactoryReview(
        thread({ factory: held, pullRequests: [link({ checksState: "passing" })] }),
        NOW,
        SAVING,
      ),
    ).toBeNull();
  });

  it("drops held work when the pull request merges", () => {
    const decision = decideFactoryReview(
      thread({
        factory: factory({ pendingWork: { summary: "CI failed.", message: "Fix CI." } }),
        pullRequests: [link({ state: "merged" })],
      }),
      NOW,
      SAVING,
    );
    expect(decision?.factory?.phase).toBe("merged");
    expect(decision?.factory?.pendingWork).toBeNull();
  });
});
