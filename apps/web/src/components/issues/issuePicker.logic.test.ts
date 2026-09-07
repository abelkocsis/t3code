import type { SourceControlIssueDetail, SourceControlIssueSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueSeedMessage,
  issueKey,
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
