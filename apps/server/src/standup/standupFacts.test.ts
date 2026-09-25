import { describe, expect, it } from "@effect/vitest";

import {
  buildCommitLogArgs,
  findUnsupportedClaims,
  hasStandupWork,
  renderStandupFacts,
  type StandupFacts,
} from "./standupFacts.ts";

const EMPTY: StandupFacts = {
  day: "2026-09-15",
  timeZone: "Europe/Budapest",
  threads: [],
  commits: [],
  pullRequests: [],
  cliSessions: [],
  todos: [],
};

describe("hasStandupWork", () => {
  it("is false for a day with nothing recorded", () => {
    expect(hasStandupWork(EMPTY)).toBe(false);
  });

  it("is true for a day whose only record is a ticked-off to-do", () => {
    expect(
      hasStandupWork({
        ...EMPTY,
        todos: [{ text: "Answer Huba on the BETH design", doneAt: "2026-09-15T14:00:00.000Z" }],
      }),
    ).toBe(true);
  });

  it("is true when any one source has something", () => {
    expect(
      hasStandupWork({
        ...EMPTY,
        commits: [{ projectTitle: "canton", sha: "abc1234", subject: "fix: credit the sender" }],
      }),
    ).toBe(true);
  });
});

describe("renderStandupFacts", () => {
  it("reports the to-do items the user ticked off", () => {
    const rendered = renderStandupFacts({
      ...EMPTY,
      todos: [{ text: "Answer Huba on the BETH design", doneAt: "2026-09-15T14:00:00.000Z" }],
    });
    expect(rendered).toContain("## To-do items you ticked off");
    expect(rendered).toContain("- Answer Huba on the BETH design");
  });

  it("leaves out a section that has nothing in it", () => {
    const rendered = renderStandupFacts({
      ...EMPTY,
      commits: [{ projectTitle: "canton", sha: "abc1234", subject: "fix: credit the sender" }],
    });
    expect(rendered).toContain("## Commits");
    expect(rendered).not.toContain("## T3 Code threads");
    expect(rendered).not.toContain("## Pull requests");
  });

  it("carries the detail a bullet needs to name its work", () => {
    const rendered = renderStandupFacts({
      ...EMPTY,
      threads: [
        {
          threadId: "t1",
          projectTitle: "attestor",
          title: "BETH review findings",
          branch: "fix/beth-review",
          userMessages: ["address Huba's review comments"],
          completedTurns: 4,
          changedFiles: ["src/beth/bridge.rs"],
        },
      ],
      pullRequests: [
        {
          repository: "DLC-link/canton",
          number: 134,
          title: "Credit only the sending account",
          state: "merged",
          url: "https://example.invalid/134",
        },
      ],
    });
    expect(rendered).toContain("[attestor] BETH review findings");
    expect(rendered).toContain("branch: fix/beth-review");
    expect(rendered).toContain("asked: address Huba's review comments");
    expect(rendered).toContain("touched: src/beth/bridge.rs");
    expect(rendered).toContain("DLC-link/canton#134 (merged)");
  });

  it("collapses whitespace so a pasted block stays one line", () => {
    const rendered = renderStandupFacts({
      ...EMPTY,
      threads: [
        {
          threadId: "t1",
          projectTitle: "web",
          title: "Fix",
          branch: null,
          userMessages: ["line one\n\nline two"],
          completedTurns: 1,
          changedFiles: [],
        },
      ],
    });
    expect(rendered).toContain("asked: line one line two");
  });

  it("caps a thread's messages so one busy thread cannot fill the prompt", () => {
    const rendered = renderStandupFacts({
      ...EMPTY,
      threads: [
        {
          threadId: "t1",
          projectTitle: "web",
          title: "Long day",
          branch: null,
          userMessages: Array.from({ length: 30 }, (_, index) => `message ${index}`),
          completedTurns: 30,
          changedFiles: [],
        },
      ],
    });
    expect(rendered).toContain("message 5");
    expect(rendered).not.toContain("message 6");
  });
});

describe("buildCommitLogArgs", () => {
  const window = { sinceIso: "2026-09-16T22:00:00.000Z", untilIso: "2026-09-17T22:00:00.000Z" };

  it("matches each identity value as a literal author and skips T3 checkpoints", () => {
    const args = buildCommitLogArgs({
      identity: ["abel@bitsafe.finance", "Ábel Kocsis"],
      ...window,
    });
    expect(args.indexOf("--exclude=refs/t3/*")).toBeLessThan(args.indexOf("--all"));
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--author=abel@bitsafe.finance");
    expect(args).toContain("--author=Ábel Kocsis");
  });

  it("leaves the log unfiltered when the worktree has no git identity", () => {
    const args = buildCommitLogArgs({ identity: [], ...window });
    expect(args.some((arg) => arg.startsWith("--author="))).toBe(false);
    expect(args).toContain("--exclude=refs/t3/*");
  });
});

describe("findUnsupportedClaims", () => {
  const knownNames = ["dlc-attestor-stack", "decentralization-manager", "t3code", "admin"];
  const evidence = [
    "## Commits",
    "- [dlc-attestor-stack] cdee71cb fix(config): keep secrets out of the config parse error",
    "## Pull requests you touched",
    "- DLC-link/dlc-attestor-stack#685 (merged) Trim comments in PR 646",
  ].join("\n");

  it("accepts a bullet whose repository and number are both in the evidence", () => {
    expect(
      findUnsupportedClaims({
        text: "Opened dlc-attestor-stack PR #685 to cut the comment bulk from PR #646.",
        evidence,
        knownNames,
      }),
    ).toEqual([]);
  });

  it("rejects a bullet naming a repository the day never touched", () => {
    expect(
      findUnsupportedClaims({
        text: "Landed decentralization-manager fixes and bumped to 1.11.0.",
        evidence,
        knownNames,
      }),
    ).toEqual(["decentralization-manager is in no evidence"]);
  });

  it("rejects a pull request number the evidence never showed", () => {
    expect(
      findUnsupportedClaims({ text: "Merged dlc-attestor-stack #470.", evidence, knownNames }),
    ).toEqual(["#470 is in no evidence"]);
  });

  it("leaves a name that reads as an ordinary word alone", () => {
    expect(
      findUnsupportedClaims({ text: "Wrote the admin runbook.", evidence, knownNames }),
    ).toEqual([]);
  });
});
