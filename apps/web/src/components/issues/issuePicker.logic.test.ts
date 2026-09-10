import type { SourceControlIssueDetail, SourceControlIssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueSections,
  buildIssueSeedMessage,
  composeIssueSeedMessage,
  issueKey,
  parseIssueLookup,
  selectedRepository,
  selectionWouldReset,
  toggleIssueSelection,
} from "./issuePicker.logic";

function summary(
  repository: string,
  number: number,
  title = `Issue ${number}`,
): SourceControlIssueSummary {
  return {
    repository,
    number,
    title,
    url: `https://github.com/${repository}/issues/${number}`,
    state: "open",
    labels: [],
    assignees: [],
    authorLogin: null,
    commentCount: 0,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    summary: "",
  };
}

function detail(
  repository: string,
  number: number,
  body: string,
  labels: ReadonlyArray<string> = [],
): SourceControlIssueDetail {
  return {
    ...summary(repository, number, `Fix the reconnect loop`),
    labels: labels.map((name) => ({ name, color: "" })),
    body,
  };
}

describe("issueKey", () => {
  it("keeps two repositories' issue number one apart", () => {
    expect(issueKey(summary("cli/cli", 7))).not.toBe(issueKey(summary("cli/go-gh", 7)));
  });
});

describe("toggleIssueSelection", () => {
  it("adds a row that is not selected", () => {
    const selected = toggleIssueSelection([], summary("cli/cli", 1));
    expect(selected.map(issueKey)).toEqual(["cli/cli#1"]);
  });

  it("removes a row that is selected", () => {
    const one = summary("cli/cli", 1);
    expect(toggleIssueSelection([one], one)).toEqual([]);
  });

  it("keeps several issues from the same repository", () => {
    let selected: ReadonlyArray<SourceControlIssueSummary> = [];
    selected = toggleIssueSelection(selected, summary("cli/cli", 1));
    selected = toggleIssueSelection(selected, summary("cli/cli", 2));
    expect(selected.map(issueKey)).toEqual(["cli/cli#1", "cli/cli#2"]);
  });

  it("starts again when a row from another repository is picked", () => {
    // One selection becomes one branch and one pull request, so it cannot
    // straddle two repositories.
    const selected = toggleIssueSelection(
      [summary("cli/cli", 1), summary("cli/cli", 2)],
      summary("cli/go-gh", 9),
    );
    expect(selected.map(issueKey)).toEqual(["cli/go-gh#9"]);
  });

  it("still deselects a row after the repository changed underneath it", () => {
    const other = summary("cli/go-gh", 9);
    expect(toggleIssueSelection([other], other)).toEqual([]);
  });
});

describe("selectedRepository", () => {
  it("is null while nothing is selected", () => {
    expect(selectedRepository([])).toBeNull();
  });

  it("is the repository every selected issue belongs to", () => {
    expect(selectedRepository([summary("cli/cli", 1)])).toBe("cli/cli");
  });
});

describe("selectionWouldReset", () => {
  const selected = [summary("cli/cli", 1)];

  it("warns for a row in another repository", () => {
    expect(selectionWouldReset(selected, summary("cli/go-gh", 9))).toBe(true);
  });

  it("stays quiet for a row in the same repository", () => {
    expect(selectionWouldReset(selected, summary("cli/cli", 2))).toBe(false);
  });

  it("stays quiet for an empty selection, which has nothing to lose", () => {
    expect(selectionWouldReset([], summary("cli/go-gh", 9))).toBe(false);
  });

  it("stays quiet for a row that is already selected, since it only deselects", () => {
    expect(selectionWouldReset(selected, summary("cli/cli", 1))).toBe(false);
  });
});

describe("buildIssueSeedMessage", () => {
  it("holds the agent back, since the user's instruction has not been written yet", () => {
    const message = buildIssueSeedMessage([detail("cli/cli", 412, "It drops the participant.")]);
    expect(message).toContain("Do not change any files and do not start the work yet");
  });

  it("carries the number, the title, the link, the labels and the whole body", () => {
    const message = buildIssueSeedMessage([
      detail("cli/cli", 412, "It drops the participant.", ["bug", "P1"]),
    ]);
    expect(message).toContain("## cli/cli#412 — Fix the reconnect loop");
    expect(message).toContain("https://github.com/cli/cli/issues/412");
    expect(message).toContain("Labels: bug, P1");
    expect(message).toContain("It drops the participant.");
  });

  it("leaves the label line out when an issue has none", () => {
    expect(buildIssueSeedMessage([detail("cli/cli", 412, "body")])).not.toContain("Labels:");
  });

  it("says so rather than trailing off when an issue has no description", () => {
    expect(buildIssueSeedMessage([detail("cli/cli", 412, "   ")])).toContain(
      "_This issue has no description._",
    );
  });

  it("separates several issues and speaks about them in the plural", () => {
    const message = buildIssueSeedMessage([
      detail("cli/cli", 412, "first"),
      detail("cli/cli", 398, "second"),
    ]);
    expect(message).toContain("work on these issues");
    expect(message.split("\n---\n")).toHaveLength(2);
  });

  it("speaks about one issue in the singular", () => {
    expect(buildIssueSeedMessage([detail("cli/cli", 412, "only")])).toContain("work on this issue");
  });
});

describe("parseIssueLookup", () => {
  it("reads an issue link as that one issue", () => {
    expect(
      parseIssueLookup("https://github.com/DLC-link/dlc-attestor-stack/issues/570", null),
    ).toEqual({ kind: "issue", repository: "DLC-link/dlc-attestor-stack", number: 570 });
  });

  it("ignores what follows the issue number in a link", () => {
    expect(parseIssueLookup("https://github.com/cli/cli/issues/12#issuecomment-99", null)).toEqual({
      kind: "issue",
      repository: "cli/cli",
      number: 12,
    });
  });

  it("reads owner/name#number as that one issue", () => {
    expect(parseIssueLookup("cli/cli#12", null)).toEqual({
      kind: "issue",
      repository: "cli/cli",
      number: 12,
    });
  });

  it("reads a repository link as a search scoped to it", () => {
    expect(parseIssueLookup("https://github.com/cli/cli", null)).toEqual({
      kind: "search",
      query: "",
      repository: "cli/cli",
    });
  });

  it("reads owner/name as a scope rather than as search text", () => {
    // Searched as text, a repository name matches only issues whose body
    // happens to mention it, which is how an issue went missing.
    expect(parseIssueLookup("DLC-link/dlc-attestor-stack", null)).toEqual({
      kind: "search",
      query: "",
      repository: "DLC-link/dlc-attestor-stack",
    });
  });

  it("keeps the words after owner/name as the search text", () => {
    expect(parseIssueLookup("cli/cli reconnect loop", null)).toEqual({
      kind: "search",
      query: "reconnect loop",
      repository: "cli/cli",
    });
  });

  it("reads a bare number inside the locked repository", () => {
    expect(parseIssueLookup("#570", "cli/cli")).toEqual({
      kind: "issue",
      repository: "cli/cli",
      number: 570,
    });
  });

  it("treats a bare number as text while no repository is locked", () => {
    expect(parseIssueLookup("570", null)).toEqual({
      kind: "search",
      query: "570",
      repository: null,
    });
  });

  it("passes plain words through as text", () => {
    expect(parseIssueLookup("  telemetry alert ", null)).toEqual({
      kind: "search",
      query: "telemetry alert",
      repository: null,
    });
  });
});

describe("composeIssueSeedMessage", () => {
  it("puts the instructions first and the issues after a blank line", () => {
    expect(composeIssueSeedMessage("Do this.", "## cli/cli#1 — Title")).toBe(
      "Do this.\n\n## cli/cli#1 — Title",
    );
  });

  it("leaves out an emptied half rather than a stray blank line", () => {
    expect(composeIssueSeedMessage("   ", "## cli/cli#1 — Title")).toBe("## cli/cli#1 — Title");
  });

  it("keeps the edited instructions untouched when the issues are rebuilt", () => {
    const edited = "Fix it directly, no questions.";
    const before = composeIssueSeedMessage(edited, buildIssueSections([detail("cli/cli", 1, "a")]));
    const after = composeIssueSeedMessage(
      edited,
      buildIssueSections([detail("cli/cli", 1, "a"), detail("cli/cli", 2, "b")]),
    );
    expect(before.startsWith(edited)).toBe(true);
    expect(after.startsWith(edited)).toBe(true);
    expect(after).toContain("cli/cli#2");
  });
});
