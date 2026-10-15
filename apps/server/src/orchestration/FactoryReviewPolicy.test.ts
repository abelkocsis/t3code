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

  it("asks the agent to handle new review comments once", () => {
    const changed = thread({
      pullRequests: [
        link({ updatedAt: NOW, reviewDecision: "changes-requested", unresolvedReviewThreads: 2 }),
      ],
    });
    const decision = decideFactoryReview(changed, NOW);
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.factory?.review).toMatchObject({ seenUpdatedAt: NOW, seenUnresolved: 2 });

    const seen = thread({
      ...changed,
      factory: { ...factory(), phase: "under-review", review: decision!.factory!.review! },
    });
    expect(decideFactoryReview(seen, NOW)).toBeNull();
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
