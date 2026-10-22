import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewRequestMessage,
  classifyShippingPullRequest,
  collectShippingItems,
  groupShippingReviews,
} from "./shipping.logic";

const green: ThreadPullRequestSnapshot = {
  state: "open",
  title: "Fix login",
  headBranch: "fix/login",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-10-01T00:00:00Z",
  syncedAt: "2026-10-01T00:00:00Z",
  reviewDecision: "review-required",
  checksState: "passing",
  mergeability: "mergeable",
  mergeState: "blocked",
  lastReviewer: null,
  unresolvedReviewThreads: 0,
};

const reviewer = (login: string) => ({ login, name: null, avatarUrl: null });

function link(number: number, snapshot: ThreadPullRequestSnapshot | null): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source: "created",
    linkedAt: "2026-10-01T00:00:00Z",
    snapshot,
    stack: null,
  };
}

function thread(
  id: string,
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    archivedAt: null,
    settledAt: null,
    pullRequests,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("classifyShippingPullRequest", () => {
  it("sends anything red to action needed, with every reason", () => {
    expect(
      classifyShippingPullRequest({
        ...green,
        checksState: "failing",
        mergeability: "conflicting",
        unresolvedReviewThreads: 2,
      }),
    ).toEqual({
      category: "action-needed",
      problems: ["conflicts", "checks-failing", "unresolved-comments"],
    });
    expect(
      classifyShippingPullRequest({ ...green, reviewDecision: "changes-requested" }).problems,
    ).toEqual(["changes-requested"]);
    expect(classifyShippingPullRequest({ ...green, mergeState: "behind" }).problems).toEqual([
      "behind",
    ]);
  });

  it("waits on running checks rather than asking for a review", () => {
    expect(classifyShippingPullRequest({ ...green, checksState: "pending" }).category).toBe(
      "waiting",
    );
  });

  it("offers a merge only where GitHub would take it", () => {
    expect(
      classifyShippingPullRequest({ ...green, reviewDecision: "approved", mergeState: "clean" })
        .category,
    ).toBe("ready-to-merge");
    // A bot's approval with the branch rules still waiting on a person.
    expect(
      classifyShippingPullRequest({ ...green, reviewDecision: "approved", mergeState: "blocked" })
        .category,
    ).toBe("ready-for-review");
  });

  it("tells a first review from a re-review by whether anyone reviewed", () => {
    expect(classifyShippingPullRequest(green).category).toBe("ready-for-review");
    expect(classifyShippingPullRequest({ ...green, lastReviewer: reviewer("ana") }).category).toBe(
      "ready-for-re-review",
    );
  });
});

describe("collectShippingItems", () => {
  it("keeps open, ready pull requests from threads that are not archived", () => {
    const items = collectShippingItems([
      thread("t1", [
        link(1, green),
        link(2, { ...green, isDraft: true }),
        link(3, { ...green, state: "merged" }),
        link(4, null),
      ]),
      thread("t2", [link(5, green)], { archivedAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(items.map((item) => item.link.number)).toEqual([1]);
  });

  it("shows a pull request linked twice once, beside the active thread", () => {
    const items = collectShippingItems([
      thread("settled", [link(1, green)], { settledAt: "2026-10-01T00:00:00Z" }),
      thread("active", [link(1, green)]),
    ]);
    expect(items.map((item) => item.thread.id)).toEqual(["active"]);
  });
});

describe("groupShippingReviews", () => {
  it("groups re-reviews by the last reviewer and puts first reviews in one shared group", () => {
    const items = collectShippingItems([
      thread("t", [
        link(1, { ...green, lastReviewer: reviewer("bo") }),
        link(2, green),
        link(3, { ...green, lastReviewer: reviewer("ana") }),
        link(4, { ...green, lastReviewer: reviewer("Bo") }),
        link(5, { ...green, checksState: "failing", lastReviewer: reviewer("ana") }),
      ]),
    ]);
    const groups = groupShippingReviews(items);
    expect(
      groups.map((group) => [
        group.reviewer?.login ?? null,
        group.items.map((item) => item.link.number),
      ]),
    ).toEqual([
      ["ana", [3]],
      ["bo", [1, 4]],
      [null, [2]],
    ]);
  });
});

describe("buildReviewRequestMessage", () => {
  it("lists one URL per line under the request", () => {
    const items = collectShippingItems([thread("t", [link(1, green), link(2, green)])]);
    expect(buildReviewRequestMessage(items)).toBe(
      [
        "Please, review following PRs:",
        "- https://github.com/acme/web/pull/1",
        "- https://github.com/acme/web/pull/2",
      ].join("\n"),
    );
  });
});
