import {
  type PullRequestActivity,
  type PullRequestDetail,
  type ThreadFactory,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  decideFactoryReview,
  factoryPullRequestView,
  type FactoryPullRequestView,
  type FactoryReviewInput,
  type FactoryReviewThread,
} from "./FactoryReviewPolicy.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const EARLIER = "2026-10-14T11:00:00.000Z";

const LINK = {
  host: "github.com",
  repository: "dlc-link/decentralization-manager",
  number: 541,
  url: "https://github.com/DLC-link/decentralization-manager/pull/541",
};

function view(overrides: Partial<FactoryPullRequestView> = {}): FactoryPullRequestView {
  return {
    state: "open",
    title: "Record purges in the audit trail",
    baseBranch: "main",
    updatedAt: EARLIER,
    reviewDecision: "review-required",
    checksState: "pending",
    mergeState: "clean",
    unresolvedReviewThreads: 0,
    ...overrides,
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
      seenMergeState: "clean",
      seenReviewId: null,
      seenCommentId: null,
    },
    ...overrides,
  };
}

function thread(overrides: Partial<FactoryReviewThread> = {}): FactoryReviewThread {
  return {
    archivedAt: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  };
}

function input(overrides: {
  readonly factory?: ThreadFactory;
  readonly view?: Partial<FactoryPullRequestView> | null;
  readonly thread?: Partial<FactoryReviewThread>;
}): FactoryReviewInput {
  return {
    thread: thread(overrides.thread),
    factory: overrides.factory ?? factory(),
    pullRequest: overrides.view === null ? null : { link: LINK, view: view(overrides.view) },
  };
}

const decide = (
  overrides: Parameters<typeof input>[0],
  options?: { readonly tokenSaving: boolean },
) => decideFactoryReview(input(overrides), NOW, options);

describe("decideFactoryReview", () => {
  it("leaves a task without a pull request alone", () => {
    expect(decide({ view: null })).toBeNull();
  });

  it("moves a done task with a pull request to ready for review", () => {
    const decision = decide({ factory: factory({ phase: "done", review: null }) });
    expect(decision?.factory?.phase).toBe("ready-for-review");
    expect(decision?.factory?.review?.seenUpdatedAt).toBe(EARLIER);
  });

  it("does not touch a task the agent still runs", () => {
    expect(decide({ factory: factory({ phase: "implementation" }) })).toBeNull();
    expect(decide({ factory: factory({ phase: "ready-for-review" }) })).toBeNull();
  });

  it("ends the task when the pull request merges or closes", () => {
    expect(decide({ view: { state: "merged" } })?.factory?.phase).toBe("merged");
    expect(decide({ view: { state: "closed" } })?.factory?.phase).toBe("done");
  });

  it("marks ready to merge on approval with green checks", () => {
    const decision = decide({
      view: { reviewDecision: "approved", checksState: "passing", mergeState: "clean" },
    });
    expect(decision?.factory?.phase).toBe("ready-to-merge");
    expect(decision?.message).toBeNull();
  });

  it("sends a stale base together with new review comments, so the rebase is not lost", () => {
    const decision = decide({ view: { lastReviewId: "PRR_2", mergeState: "behind" } });
    expect(decision?.message).toContain("Several things need work");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.message).toContain("Rebase this branch onto the base branch");
    expect(decision?.factory?.summary).toBe(
      "Rebasing onto the base branch. Reading new review comments.",
    );
  });

  it("holds a stale base and new comments as one piece of work under token saving", () => {
    const decision = decide(
      { view: { lastReviewId: "PRR_2", mergeState: "behind" } },
      { tokenSaving: true },
    );
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.pendingWork?.message).toContain("Rebase this branch");
    expect(decision?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("asks the agent to handle a new human review once", () => {
    const changed = {
      updatedAt: NOW,
      reviewDecision: "changes-requested" as const,
      lastReviewId: "PRR_2",
      unresolvedReviewThreads: 2,
    };
    const decision = decide({ view: changed });
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.factory?.review).toMatchObject({ seenReviewId: "PRR_2", seenUnresolved: 2 });

    expect(
      decide({
        factory: { ...factory(), phase: "under-review", review: decision!.factory!.review! },
        view: changed,
      }),
    ).toBeNull();
  });

  it("does not resend a handled review or the threads the agent declined", () => {
    // The agent fixed one comment, declined two, and the human marked the task again.
    const marked = factory({
      reviewRound: 2,
      review: {
        seenUpdatedAt: NOW,
        seenUnresolved: 2,
        seenChecksState: "passing",
        seenMergeState: "clean",
        seenReviewId: "PRR_1",
      },
    });
    expect(
      decide({
        factory: marked,
        view: {
          updatedAt: NOW,
          reviewDecision: "changes-requested",
          checksState: "passing",
          lastReviewId: "PRR_1",
          unresolvedReviewThreads: 2,
        },
      }),
    ).toBeNull();
  });

  it("marks ready to merge on a new approval, holding no work under token saving", () => {
    const decision = decide(
      {
        view: {
          lastReviewId: "PRR_1",
          reviewDecision: "approved",
          checksState: "passing",
          mergeState: "clean",
        },
      },
      { tokenSaving: true },
    );
    expect(decision?.factory?.phase).toBe("ready-to-merge");
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.pendingWork ?? null).toBeNull();
    expect(decision?.factory?.review?.seenReviewId).toBe("PRR_1");
  });

  it("sends a new review on an approved pull request that still has open threads", () => {
    const decision = decide({
      view: {
        lastReviewId: "PRR_1",
        reviewDecision: "approved",
        checksState: "passing",
        mergeState: "clean",
        unresolvedReviewThreads: 1,
      },
    });
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
  });

  it("counts a new thread after the agent resolved some", () => {
    const resolved = decide({
      factory: factory({
        review: {
          seenUpdatedAt: EARLIER,
          seenUnresolved: 3,
          seenChecksState: "pending",
          seenMergeState: "clean",
          seenReviewId: null,
        },
      }),
      view: { unresolvedReviewThreads: 1 },
    });
    expect(resolved?.message).toBeNull();
    expect(resolved?.factory?.review?.seenUnresolved).toBe(1);

    const opened = decide({
      factory: { ...factory(), review: resolved!.factory!.review! },
      view: { unresolvedReviewThreads: 2 },
    });
    expect(opened?.message).toContain("New review activity");
  });

  it("keeps the remembered thread count when the activity could not be read", () => {
    const { unresolvedReviewThreads: _, ...unread } = view();
    expect(
      decideFactoryReview(
        {
          ...input({}),
          factory: factory({ review: { ...factory().review!, seenUnresolved: 2 } }),
          pullRequest: { link: LINK, view: unread },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("asks the agent to answer a new conversation comment once", () => {
    const commented = { updatedAt: NOW, lastCommentId: "IC_1" };
    const decision = decide({ view: commented });
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.message).toContain("New review activity");
    expect(decision?.factory?.review?.seenCommentId).toBe("IC_1");

    expect(
      decide({ factory: { ...factory(), review: decision!.factory!.review! }, view: commented }),
    ).toBeNull();
  });

  it("does not mark ready to merge over a conversation comment the agent was not sent", () => {
    const decision = decide({
      view: {
        reviewDecision: "approved",
        checksState: "passing",
        mergeState: "clean",
        lastCommentId: "IC_1",
      },
    });
    expect(decision?.factory?.phase).toBe("fix");
  });

  it("treats the current comment as handled on a memo from before comment ids", () => {
    const { seenCommentId: _, ...oldMemo } = factory().review!;
    const decision = decide({
      factory: factory({ review: oldMemo }),
      view: { lastCommentId: "IC_1" },
    });
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.review?.seenCommentId).toBe("IC_1");
  });

  it("treats the current review as handled on a memo from before review ids", () => {
    const { seenReviewId: _, ...oldMemo } = factory().review!;
    const decision = decide({
      factory: factory({ review: oldMemo }),
      view: { lastReviewId: "PRR_1" },
    });
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.review?.seenReviewId).toBe("PRR_1");
  });

  it("asks the agent to look at a failed check and a stale base once each", () => {
    const failing = decide({ view: { checksState: "failing" } });
    expect(failing?.message).toContain("CI is failing");
    expect(failing?.factory?.review?.seenChecksState).toBe("failing");

    const behind = decide({ view: { mergeState: "behind" } });
    expect(behind?.message).toContain("moved ahead");
    expect(behind?.factory?.review?.seenMergeState).toBe("behind");
  });

  it("keeps a task ready for review rebased and green", () => {
    const readyForReview = factory({ phase: "ready-for-review" });
    const conflicts = decide({ factory: readyForReview, view: { mergeState: "dirty" } });
    expect(conflicts?.factory?.phase).toBe("fix");
    expect(conflicts?.message).toContain("Rebase this branch");

    const failing = decide({ factory: readyForReview, view: { checksState: "failing" } });
    expect(failing?.factory?.phase).toBe("fix");
    expect(failing?.message).toContain("CI is failing");

    // Nobody reviews yet, so comments wait until the task is under review.
    expect(
      decide({ factory: readyForReview, view: { updatedAt: NOW, unresolvedReviewThreads: 2 } }),
    ).toBeNull();
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
      decide({ factory: seenFailing, view: { checksState: "failing", mergeState: "dirty" } }),
    ).toBeNull();

    const cleared = decide({
      factory: seenFailing,
      view: { checksState: "passing", mergeState: "clean" },
    });
    expect(cleared?.message).toBeNull();
    expect(cleared?.factory?.phase).toBe("ready-for-review");
    expect(cleared?.factory?.updatedAt).toBe(EARLIER);
    expect(cleared?.factory?.review?.seenChecksState).toBe("passing");

    const again = decide({ factory: cleared!.factory!, view: { checksState: "failing" } });
    expect(again?.message).toContain("CI is failing");
  });

  it("handles a failure already present when the task becomes ready for review", () => {
    const done = decide({
      factory: factory({ phase: "done", review: null }),
      view: { mergeState: "dirty" },
    });
    const next = decide({ factory: done!.factory!, view: { mergeState: "dirty" } });
    expect(next?.message).toContain("Rebase this branch");
  });

  it("waits with the message while the agent is busy or a question is open", () => {
    expect(decide({ view: { checksState: "failing" }, thread: { status: "running" } })).toBeNull();
    expect(
      decide({
        view: { checksState: "failing" },
        thread: {
          pendingRuntimeRequest: {
            id: "request-1" as never,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        },
      }),
    ).toBeNull();
    expect(
      decide({
        view: { checksState: "failing" },
        thread: { pendingBackgroundTasks: [{ taskId: "ci", kind: "monitor" }] as never },
      }),
    ).toBeNull();
  });

  it("drops ready to merge back to under review when the pull request changes", () => {
    const decision = decide({
      factory: factory({ phase: "ready-to-merge" }),
      view: { updatedAt: NOW, checksState: "pending" },
    });
    expect(decision?.factory?.phase).toBe("under-review");
    expect(decision?.message).toBeNull();
  });
});

describe("decideFactoryReview with token saving", () => {
  const SAVING = { tokenSaving: true };

  it("holds review work instead of messaging the agent, and keeps the phase", () => {
    const decision = decide({ view: { checksState: "failing" } }, SAVING);
    expect(decision?.message).toBeNull();
    expect(decision?.factory?.phase).toBe("under-review");
    expect(decision?.factory?.pendingWork?.message).toContain("CI is failing");
    expect(decision?.factory?.review?.seenChecksState).toBe("failing");
  });

  it("holds work while the agent is busy, since nothing is sent", () => {
    const decision = decide(
      { view: { mergeState: "behind" }, thread: { status: "running" } },
      SAVING,
    );
    expect(decision?.factory?.pendingWork?.message).toContain("moved ahead");
  });

  it("adds new work to work already held", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    const decision = decide(
      {
        factory: held,
        view: { updatedAt: NOW, reviewDecision: "changes-requested", unresolvedReviewThreads: 1 },
      },
      SAVING,
    );
    expect(decision?.factory?.pendingWork?.message).toContain("CI is failing on the branch.");
    expect(decision?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("sends held work once token saving is off and the agent is free", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    const decision = decide({ factory: held });
    expect(decision?.message).toMatch(/^CI is failing on the branch\./);
    // The work waited, so the agent also checks the whole pull request.
    expect(decision?.message).toContain("Rebase onto the base branch if it moved ahead");
    expect(decision?.message).toContain("conversation comment");
    expect(decision?.factory?.phase).toBe("fix");
    expect(decision?.factory?.pendingWork).toBeNull();

    expect(decide({ factory: held, thread: { status: "running" } })).toBeNull();
  });

  it("drops a held CI failure that passed on a rerun", () => {
    const failed = decide({ view: { checksState: "failing" } }, SAVING)!.factory!;
    const rerun = decide({ factory: failed, view: { checksState: "pending" } }, SAVING);
    expect(rerun?.message).toBeNull();
    expect(rerun?.factory?.pendingWork).toBeNull();
    expect(rerun?.factory?.updatedAt).toBe(failed.updatedAt);

    // Work held before parts existed is matched by its message.
    const { parts: _, ...legacy } = failed.pendingWork!;
    const legacyRerun = decide(
      { factory: { ...failed, pendingWork: legacy }, view: { checksState: "passing" } },
      SAVING,
    );
    expect(legacyRerun?.factory?.pendingWork).toBeNull();
  });

  it("keeps held review feedback when the held CI failure clears", () => {
    const held = decide(
      { view: { checksState: "failing", lastCommentId: "IC_1" } },
      SAVING,
    )!.factory!;
    expect(held.pendingWork?.parts?.map((part) => part.cause)).toEqual(["ci", "comments"]);

    const cleared = decide(
      { factory: held, view: { checksState: "passing", lastCommentId: "IC_1" } },
      SAVING,
    );
    expect(cleared?.factory?.pendingWork?.parts?.map((part) => part.cause)).toEqual(["comments"]);
    expect(cleared?.factory?.pendingWork?.message).not.toContain("CI is failing");
    expect(cleared?.factory?.pendingWork?.message).toContain("New review activity");
  });

  it("drops a held rebase once the branch is up to date", () => {
    const behind = decide({ view: { mergeState: "behind" } }, SAVING)!.factory!;
    const updated = decide({ factory: behind, view: { mergeState: "clean" } }, SAVING);
    expect(updated?.factory?.pendingWork).toBeNull();
  });

  it("keeps old held work it cannot split", () => {
    const held = factory({
      pendingWork: { summary: "CI failed.", message: "CI is failing on the branch." },
    });
    expect(decide({ factory: held, view: { checksState: "passing" } }, SAVING)).toBeNull();
  });

  it("drops held work when the pull request merges", () => {
    const decision = decide(
      {
        factory: factory({ pendingWork: { summary: "CI failed.", message: "Fix CI." } }),
        view: { state: "merged" },
      },
      SAVING,
    );
    expect(decision?.factory?.phase).toBe("merged");
    expect(decision?.factory?.pendingWork).toBeNull();
  });
});

describe("factoryPullRequestView", () => {
  const snapshot: ThreadPullRequestSnapshot = {
    state: "open",
    title: "Record purges",
    headBranch: "feature/purge",
    baseBranch: "main",
    isDraft: false,
    updatedAt: EARLIER,
    syncedAt: EARLIER,
    reviewDecision: "changes-requested",
    checksState: "passing",
    mergeability: "mergeable",
  };
  const author = { login: "agent-bot", name: null, avatarUrl: null };
  const reviewer = { login: "schronck", name: null, avatarUrl: null };
  const detail = {
    state: "open",
    title: "Record purges",
    baseBranch: "main",
    updatedAt: NOW,
    checks: [],
    mergeability: "mergeable",
    author,
  } satisfies Parameters<typeof factoryPullRequestView>[1];
  const comment = (
    id: string,
    kind: PullRequestActivity["comments"][number]["kind"],
    by: typeof author,
    createdAt: string,
  ): PullRequestActivity["comments"][number] => ({
    id,
    kind,
    author: by,
    body: "x",
    createdAt,
    url: null,
    path: null,
    reviewState: null,
  });

  it("takes the newest human review and conversation comment by someone else", () => {
    const result = factoryPullRequestView(snapshot, detail, {
      author,
      comments: [
        comment("PRR_1", "review", reviewer, EARLIER),
        comment("PRR_2", "review", reviewer, NOW),
        comment("PRR_own", "review", author, NOW),
        comment("IC_1", "issue-comment", reviewer, EARLIER),
        comment("IC_bot", "issue-comment", { ...reviewer, login: "dependabot[bot]" }, NOW),
        comment("RC_1", "review-comment", reviewer, NOW),
      ],
      reviewThreads: [
        {
          id: "t1",
          path: "a.ts",
          line: 1,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [],
        },
        {
          id: "t2",
          path: "a.ts",
          line: 2,
          side: "right",
          isResolved: true,
          isOutdated: false,
          comments: [],
        },
      ],
    });
    expect(result).toMatchObject({
      lastReviewId: "PRR_2",
      lastCommentId: "IC_1",
      unresolvedReviewThreads: 1,
      reviewDecision: "changes-requested",
      checksState: "passing",
      mergeState: "clean",
    });
  });

  it("reads a stale base from the comparison and conflicts from mergeability", () => {
    expect(factoryPullRequestView(snapshot, { ...detail, behindBy: 3 }, null).mergeState).toBe(
      "behind",
    );
    expect(
      factoryPullRequestView(snapshot, { ...detail, baseComparison: "behind" }, null).mergeState,
    ).toBe("behind");
    expect(
      factoryPullRequestView(
        snapshot,
        { ...detail, mergeability: "conflicting", behindBy: 3 },
        null,
      ).mergeState,
    ).toBe("dirty");
  });

  it("derives the checks state from the detail when the snapshot has none", () => {
    const checks: PullRequestDetail["checks"] = [
      { name: "build", status: "success", description: null, url: null },
      { name: "test", status: "failure", description: null, url: null },
    ];
    expect(
      factoryPullRequestView({ ...snapshot, checksState: null }, { ...detail, checks }, null)
        .checksState,
    ).toBe("failing");
  });

  it("leaves the review fields absent without an activity read", () => {
    const result = factoryPullRequestView(snapshot, detail, null);
    expect("lastReviewId" in result).toBe(false);
    expect("unresolvedReviewThreads" in result).toBe(false);
  });
});
