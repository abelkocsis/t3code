import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH } from "@t3tools/contracts";
import {
  buildGitHubIssueDetailPath,
  buildGitHubIssueSearchPath,
  buildGitHubIssueSearchQuery,
  decodeGitHubIssueDetailJson,
  decodeGitHubIssueSearchJson,
  repositoryFromApiUrl,
  summarizeIssueBody,
} from "./gitHubIssues.ts";

const SEARCH_DEFAULTS = {
  query: "",
  assignedToViewer: false,
  repository: null,
} as const;

/** One item as `GET search/issues` returns it. */
const ITEM = {
  assignees: [{ login: "kocsisabel" }],
  user: { login: "lenamonj" },
  body: "The command panics when the name is short.",
  comments: 1,
  created_at: "2026-09-07T03:11:42Z",
  labels: [{ color: "D6393F", description: "needs review", name: "needs-triage" }],
  number: 14372,
  repository_url: "https://api.github.com/repos/cli/cli",
  state: "open",
  title: "gh repo garden panics on a short repository name",
  updated_at: "2026-09-07T03:16:04Z",
  html_url: "https://github.com/cli/cli/issues/14372",
};

function search(items: ReadonlyArray<unknown>) {
  const decoded = decodeGitHubIssueSearchJson(JSON.stringify({ items }));
  if (!Result.isSuccess(decoded)) throw new Error("expected the rows to decode");
  return decoded.success;
}

describe("buildGitHubIssueSearchQuery", () => {
  it("asks only for open issues, never pull requests", () => {
    expect(buildGitHubIssueSearchQuery(SEARCH_DEFAULTS)).toBe("is:issue is:open");
  });

  it("adds the viewer filter only when it is on", () => {
    expect(buildGitHubIssueSearchQuery({ ...SEARCH_DEFAULTS, assignedToViewer: true })).toBe(
      "is:issue is:open assignee:@me",
    );
  });

  it("scopes to one repository when given one", () => {
    expect(buildGitHubIssueSearchQuery({ ...SEARCH_DEFAULTS, repository: " cli/cli " })).toBe(
      "is:issue is:open repo:cli/cli",
    );
  });

  it("puts the user's own text last, so a qualifier they type cannot take over a filter", () => {
    expect(
      buildGitHubIssueSearchQuery({
        ...SEARCH_DEFAULTS,
        assignedToViewer: true,
        query: "  -label:wontfix reconnect ",
      }),
    ).toBe("is:issue is:open assignee:@me -label:wontfix reconnect");
  });
});

describe("buildGitHubIssueSearchPath", () => {
  it("sorts by activity and bounds the page", () => {
    const path = buildGitHubIssueSearchPath({ ...SEARCH_DEFAULTS, query: "a b", limit: 40 });
    const params = new URLSearchParams(path.slice("search/issues?".length));
    expect(path.startsWith("search/issues?")).toBe(true);
    expect(params.get("q")).toBe("is:issue is:open a b");
    expect(params.get("sort")).toBe("updated");
    expect(params.get("order")).toBe("desc");
    expect(params.get("per_page")).toBe("40");
  });
});

describe("buildGitHubIssueDetailPath", () => {
  it("names the repository and the number", () => {
    expect(buildGitHubIssueDetailPath({ repository: "cli/cli", number: 14372 })).toBe(
      "repos/cli/cli/issues/14372",
    );
  });
});

describe("repositoryFromApiUrl", () => {
  it("reads owner/name off the API URL", () => {
    expect(repositoryFromApiUrl("https://api.github.com/repos/cli/cli")).toBe("cli/cli");
    expect(repositoryFromApiUrl("https://ghe.example.com/api/v3/repos/acme/web/")).toBe("acme/web");
  });

  it("gives nothing for a URL that names no repository", () => {
    expect(repositoryFromApiUrl("https://api.github.com/users/cli")).toBeNull();
    expect(repositoryFromApiUrl(null)).toBeNull();
  });
});

describe("decodeGitHubIssueSearchJson", () => {
  it("turns an item into a row with a summary and no body", () => {
    const [row] = search([ITEM]).issues;
    expect(row).toEqual({
      repository: "cli/cli",
      number: 14372,
      title: ITEM.title,
      url: ITEM.html_url,
      state: "open",
      labels: [{ name: "needs-triage", color: "D6393F" }],
      assignees: ["kocsisabel"],
      authorLogin: "lenamonj",
      commentCount: 1,
      createdAt: ITEM.created_at,
      updatedAt: ITEM.updated_at,
      summary: ITEM.body,
    });
    expect(row).not.toHaveProperty("body");
  });

  it("drops pull requests, which the search endpoint lists among issues", () => {
    const batch = search([{ ...ITEM, pull_request: { url: "https://api.github.com/x" } }, ITEM]);
    expect(batch.issues).toHaveLength(1);
    expect(batch.rawCount).toBe(2);
  });

  it("drops an item it cannot read rather than failing the list", () => {
    expect(search([{ number: "not a number" }, ITEM]).issues).toHaveLength(1);
  });

  it("drops an item whose repository it cannot name", () => {
    expect(search([{ ...ITEM, repository_url: null }]).issues).toHaveLength(0);
  });

  it("keeps a label without a colour and skips one without a name", () => {
    const [row] = search([
      { ...ITEM, labels: [{ name: "bug" }, { color: "ffffff" }, null] },
    ]).issues;
    expect(row!.labels).toEqual([{ name: "bug", color: "" }]);
  });

  it("fails when the response is not a search result", () => {
    expect(Result.isFailure(decodeGitHubIssueSearchJson("[]"))).toBe(true);
    expect(Result.isFailure(decodeGitHubIssueSearchJson("not json"))).toBe(true);
  });
});

describe("decodeGitHubIssueDetailJson", () => {
  it("keeps the whole body and takes the repository from the reference", () => {
    const { repository_url: _url, ...record } = ITEM;
    const decoded = decodeGitHubIssueDetailJson(JSON.stringify({ ...record, state: "CLOSED" }), {
      repository: "cli/cli",
      number: 14372,
    });
    if (!Result.isSuccess(decoded)) throw new Error("expected the issue to decode");
    expect(decoded.success.body).toBe(ITEM.body);
    expect(decoded.success.repository).toBe("cli/cli");
    expect(decoded.success.state).toBe("closed");
    expect(decoded.success.commentCount).toBe(1);
  });

  it("reads a missing body as empty", () => {
    const decoded = decodeGitHubIssueDetailJson(JSON.stringify({ ...ITEM, body: null }), {
      repository: "cli/cli",
      number: 14372,
    });
    if (!Result.isSuccess(decoded)) throw new Error("expected the issue to decode");
    expect(decoded.success.body).toBe("");
  });
});

describe("summarizeIssueBody", () => {
  it("flattens markdown into one line of prose", () => {
    expect(summarizeIssueBody("## Steps\n\n- run it\n- watch it `panic`\n\n> quoted")).toBe(
      "Steps run it watch it panic quoted",
    );
  });

  it("leaves out code blocks and comments, which are not prose", () => {
    expect(summarizeIssueBody("Before <!-- hidden --> ```sh\nrm -rf\n``` after")).toBe(
      "Before after",
    );
  });

  it("cuts on a word near the bound and marks the cut", () => {
    const summary = summarizeIssueBody(`${"word ".repeat(100)}end`);
    expect(summary.length).toBeLessThanOrEqual(SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH + 1);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.endsWith("word…")).toBe(true);
  });

  it("reads nothing as nothing", () => {
    expect(summarizeIssueBody(null)).toBe("");
    expect(summarizeIssueBody("   ")).toBe("");
  });
});
