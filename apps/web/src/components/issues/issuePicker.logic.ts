import type { SourceControlIssueDetail, SourceControlIssueSummary } from "@t3tools/contracts";

/** Stable per-row identity. An issue number only identifies an issue inside its repository. */
export function issueKey(issue: { readonly repository: string; readonly number: number }): string {
  return `${issue.repository}#${issue.number}`;
}

/**
 * Add or remove an issue from the selection.
 *
 * One selection means one thread, one branch and one pull request, so it can
 * only ever hold issues from a single repository. Picking one from elsewhere
 * starts the selection again rather than being refused: a user who clicks a
 * row in another repository has changed their mind, and a row that silently
 * does nothing reads as a broken list.
 */
export function toggleIssueSelection(
  selected: ReadonlyArray<SourceControlIssueSummary>,
  issue: SourceControlIssueSummary,
): ReadonlyArray<SourceControlIssueSummary> {
  const key = issueKey(issue);
  if (selected.some((each) => issueKey(each) === key)) {
    return selected.filter((each) => issueKey(each) !== key);
  }
  const repository = selectedRepository(selected);
  return repository !== null && repository !== issue.repository ? [issue] : [...selected, issue];
}

/** The repository the selection is locked to, or null while nothing is selected. */
export function selectedRepository(
  selected: ReadonlyArray<SourceControlIssueSummary>,
): string | null {
  return selected[0]?.repository ?? null;
}

/** Whether picking this row would discard what is already selected. */
export function selectionWouldReset(
  selected: ReadonlyArray<SourceControlIssueSummary>,
  issue: SourceControlIssueSummary,
): boolean {
  const repository = selectedRepository(selected);
  return (
    repository !== null &&
    repository !== issue.repository &&
    !selected.some((each) => issueKey(each) === issueKey(issue))
  );
}

/**
 * What one entry in the search box asks for.
 *
 * `search` runs a free-text search, scoped to one repository when the entry
 * named one. `issue` names a single issue outright, so it is read directly
 * rather than searched for: a search sorted by activity only shows the most
 * recent rows, and an issue the user can already point at must never hide
 * behind that cut.
 */
export type IssueLookup =
  | {
      readonly kind: "search";
      readonly query: string;
      readonly repository: string | null;
    }
  | { readonly kind: "issue"; readonly repository: string; readonly number: number };

const OWNER_REPO = String.raw`([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9_.-]+?)`;
const GITHUB_HOST = String.raw`^(?:https?://)?(?:www\.)?github\.com/`;
const ISSUE_URL = new RegExp(`${GITHUB_HOST}${OWNER_REPO}/issues/(\\d+)(?:[/?#].*)?$`, "u");
const REPOSITORY_URL = new RegExp(`${GITHUB_HOST}${OWNER_REPO}(?:\\.git)?/?(?:[?#].*)?$`, "u");
const REPOSITORY_HASH = new RegExp(`^${OWNER_REPO}#(\\d+)$`, "u");
const REPOSITORY_ONLY = new RegExp(`^${OWNER_REPO}$`, "u");
const NUMBER_ONLY = /^#?(\d+)$/u;

/** Whether the entry is a bare issue number, which only means something inside a repository. */
export function isBareIssueNumber(raw: string): boolean {
  return NUMBER_ONLY.test(raw.trim());
}

/**
 * Read the search box.
 *
 * Accepted shapes, in this order: an issue link, `owner/name#123`, a
 * repository link, `owner/name` on its own or followed by search words, and a
 * bare `#123` while the selection has locked a repository. Anything else is
 * free text. A path-like search term such as `src/app` is read as a
 * repository too; GitHub then reports that it cannot be found, which tells the
 * user what happened.
 */
export function parseIssueLookup(raw: string, lockedRepository: string | null): IssueLookup {
  const text = raw.trim();
  const issueUrl = ISSUE_URL.exec(text);
  if (issueUrl !== null) {
    return {
      kind: "issue",
      repository: `${issueUrl[1]}/${issueUrl[2]}`,
      number: Number(issueUrl[3]),
    };
  }
  const repositoryHash = REPOSITORY_HASH.exec(text);
  if (repositoryHash !== null) {
    return {
      kind: "issue",
      repository: `${repositoryHash[1]}/${repositoryHash[2]}`,
      number: Number(repositoryHash[3]),
    };
  }
  const repositoryUrl = REPOSITORY_URL.exec(text);
  if (repositoryUrl !== null) {
    return { kind: "search", query: "", repository: `${repositoryUrl[1]}/${repositoryUrl[2]}` };
  }
  const [head = "", ...rest] = text.split(/\s+/u);
  const repositoryOnly = REPOSITORY_ONLY.exec(head);
  if (repositoryOnly !== null) {
    return {
      kind: "search",
      query: rest.join(" "),
      repository: `${repositoryOnly[1]}/${repositoryOnly[2]}`,
    };
  }
  const numberOnly = NUMBER_ONLY.exec(text);
  if (numberOnly !== null && lockedRepository !== null) {
    return { kind: "issue", repository: lockedRepository, number: Number(numberOnly[1]) };
  }
  return { kind: "search", query: text, repository: null };
}

/**
 * The instruction that opens the thread's first message.
 *
 * It explicitly holds the agent back, because the instruction that follows is
 * the user's own and they have not written it yet. Without the hold, a capable
 * agent reads a bug report as a request to fix it and starts editing before
 * anyone has agreed what to do.
 */
export function defaultIssueInstructions(issueCount: number): string {
  const plural = issueCount === 1 ? "this issue" : "these issues";
  return [
    `We are going to work on ${plural}. Read them, then tell me what you understand and anything that looks unclear.`,
    "",
    "Do not change any files and do not start the work yet. My next message says what to do.",
  ].join("\n");
}

/** The issues themselves: number, title, link, labels and the whole body, one section each. */
export function buildIssueSections(issues: ReadonlyArray<SourceControlIssueDetail>): string {
  return issues
    .map((issue) => {
      const labels = issue.labels.map((label) => label.name).join(", ");
      return [
        `## ${issue.repository}#${issue.number} — ${issue.title}`,
        issue.url,
        labels.length > 0 ? `Labels: ${labels}` : null,
        "",
        issue.body.trim().length > 0 ? issue.body.trim() : "_This issue has no description._",
      ]
        .filter((line) => line !== null)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * The thread's first message: the user's instructions, then the issues.
 *
 * The two halves are kept apart so that the picker can rebuild the issues
 * whenever the selection changes without touching what the user typed.
 */
export function composeIssueSeedMessage(instructions: string, sections: string): string {
  return [instructions.trim(), sections.trim()].filter((part) => part.length > 0).join("\n\n");
}

/** The first message as the picker offers it before the user edits anything. */
export function buildIssueSeedMessage(issues: ReadonlyArray<SourceControlIssueDetail>): string {
  return composeIssueSeedMessage(
    defaultIssueInstructions(issues.length),
    buildIssueSections(issues),
  );
}
