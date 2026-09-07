import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH } from "@t3tools/contracts";
import {
  buildGitHubIssueDetailArgs,
  buildGitHubIssueSearchArgs,
  decodeGitHubIssueDetailJson,
  decodeGitHubIssueSearchJson,
  summarizeIssueBody,
} from "./gitHubIssues.ts";

const SEARCH_DEFAULTS = {
  query: "",
  assignedToViewer: false,
  repository: null,
  limit: 30,
} as const;

/** One row exactly as `gh search issues --json` prints it. */
const ROW = {
  assignees: [{ login: "kocsisabel" }],
  author: { login: "lenamonj" },
  body: "The command panics when the name is short.",
  commentsCount: 1,
  createdAt: "2026-09-07T03:11:42Z",
  isPullRequest: false,
  labels: [{ color: "D6393F", description: "needs review", name: "needs-triage" }],
  number: 14372,
  repository: { name: "cli", nameWithOwner: "cli/cli" },
  state: "open",
  title: "gh repo garden panics on a short repository name",
  updatedAt: "2026-09-07T03:16:04Z",
  url: "https://github.com/cli/cli/issues/14372",
};

function search(rows: ReadonlyArray<unknown>) {
  const decoded = decodeGitHubIssueSearchJson(JSON.stringify(rows));
  if (!Result.isSuccess(decoded)) throw new Error("expected the rows to decode");
  return decoded.success.issues;
}

describe("buildGitHubIssueSearchArgs", () => {
  it("asks only for open issues, newest activity first", () => {
    const args = buildGitHubIssueSearchArgs(SEARCH_DEFAULTS);
    expect(args.slice(0, 2)).toEqual(["search", "issues"]);
    expect(args).toContain("--state");
    expect(args[args.indexOf("--state") + 1]).toBe("open");
    expect(args[args.indexOf("--sort") + 1]).toBe("updated");
    expect(args).not.toContain("--include-prs");
  });

  it("adds the viewer filter only when it is on", () => {
    expect(buildGitHubIssueSearchArgs(SEARCH_DEFAULTS)).not.toContain("--assignee");
    const filtered = buildGitHubIssueSearchArgs({ ...SEARCH_DEFAULTS, assignedToViewer: true });
    expect(filtered[filtered.indexOf("--assignee") + 1]).toBe("@me");
  });

  it("scopes to one repository when given one, and to none otherwise", () => {
    expect(buildGitHubIssueSearchArgs(SEARCH_DEFAULTS)).not.toContain("--repo");
    const scoped = buildGitHubIssueSearchArgs({ ...SEARCH_DEFAULTS, repository: " cli/cli " });
    expect(scoped[scoped.indexOf("--repo") + 1]).toBe("cli/cli");
  });

  it("sends a free-text term after the flag terminator so a negation is not read as a flag", () => {
    const args = buildGitHubIssueSearchArgs({ ...SEARCH_DEFAULTS, query: "  -label:wontfix  " });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("-label:wontfix");
  });

  it("omits the terminator when there is no term to protect", () => {
    expect(buildGitHubIssueSearchArgs({ ...SEARCH_DEFAULTS, query: "   " })).not.toContain("--");
  });
});

describe("buildGitHubIssueDetailArgs", () => {
  it("names the repository so the call does not depend on the working directory", () => {
    expect(buildGitHubIssueDetailArgs({ repository: "cli/cli", number: 14372 })).toEqual([
      "issue",
      "view",
      "14372",
      "--repo",
      "cli/cli",
      "--json",
      expect.stringContaining("body"),
    ]);
  });
});

describe("decodeGitHubIssueSearchJson", () => {
  it("reads a row as the picker needs it", () => {
    expect(search([ROW])).toEqual([
      {
        repository: "cli/cli",
        number: 14372,
        title: "gh repo garden panics on a short repository name",
        url: "https://github.com/cli/cli/issues/14372",
        state: "open",
        labels: [{ name: "needs-triage", color: "D6393F" }],
        assignees: ["kocsisabel"],
        authorLogin: "lenamonj",
        commentCount: 1,
        createdAt: "2026-09-07T03:11:42Z",
        updatedAt: "2026-09-07T03:16:04Z",
        summary: "The command panics when the name is short.",
      },
    ]);
  });

  it("drops a pull request that reached the results anyway", () => {
    expect(search([{ ...ROW, isPullRequest: true }])).toEqual([]);
  });

  it("drops a row with no repository, since nothing could be cloned for it", () => {
    expect(search([{ ...ROW, repository: null }])).toEqual([]);
  });

  it("keeps the readable rows when one of them is malformed", () => {
    const rows = search([
      { ...ROW, number: "not-a-number" },
      { ...ROW, number: 7 },
    ]);
    expect(rows.map((row) => row.number)).toEqual([7]);
  });

  it("keeps a label that has lost its colour and drops one that has lost its name", () => {
    const [row] = search([
      {
        ...ROW,
        labels: [
          { name: "bug", color: null },
          { name: "  ", color: "ff0000" },
        ],
      },
    ]);
    expect(row?.labels).toEqual([{ name: "bug", color: "" }]);
  });

  it("reports a closed issue as closed whatever case the host uses", () => {
    expect(search([{ ...ROW, state: "CLOSED" }])[0]?.state).toBe("closed");
  });

  it("counts the rows the host returned, not the rows that survived filtering", () => {
    const decoded = decodeGitHubIssueSearchJson(
      JSON.stringify([ROW, { ...ROW, isPullRequest: true }]),
    );
    if (!Result.isSuccess(decoded)) throw new Error("expected the rows to decode");
    expect(decoded.success.issues).toHaveLength(1);
    expect(decoded.success.rawCount).toBe(2);
  });

  it("fails rather than guessing when the payload is not a list of rows", () => {
    expect(Result.isSuccess(decodeGitHubIssueSearchJson("{}"))).toBe(false);
  });
});

describe("summarizeIssueBody", () => {
  it("leaves a short body alone", () => {
    expect(summarizeIssueBody("Reconnect drops the participant.")).toBe(
      "Reconnect drops the participant.",
    );
  });

  it("drops code fences, HTML comments and markdown structure", () => {
    const body = [
      "<!-- please fill this in -->",
      "## Steps",
      "- run **the** thing",
      "```ts",
      "const secret = 1;",
      "```",
    ].join("\n");
    expect(summarizeIssueBody(body)).toBe("Steps run the thing");
  });

  it("cuts a long body on a word boundary and marks the cut", () => {
    const summary = summarizeIssueBody("reconnect ".repeat(80));
    expect(summary.length).toBeLessThanOrEqual(SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH + 1);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain("recon…");
  });

  it("treats a missing body as no preview", () => {
    expect(summarizeIssueBody(null)).toBe("");
  });
});

describe("decodeGitHubIssueDetailJson", () => {
  const ref = { repository: "cli/cli", number: 14372 } as const;

  it("keeps the whole body and takes the repository from the reference", () => {
    const body = "## Steps\n\nRun `gh repo garden`.\n\nIt panics.";
    const decoded = decodeGitHubIssueDetailJson(
      JSON.stringify({ ...ROW, repository: undefined, commentsCount: undefined, body }),
      ref,
    );
    if (!Result.isSuccess(decoded)) throw new Error("expected the issue to decode");
    expect(decoded.success.body).toBe(body);
    expect(decoded.success.repository).toBe("cli/cli");
    expect(decoded.success.summary).toBe("Steps Run gh repo garden . It panics.");
  });

  it("fails when the payload is not an issue", () => {
    expect(Result.isSuccess(decodeGitHubIssueDetailJson("[]", ref))).toBe(false);
  });
});
