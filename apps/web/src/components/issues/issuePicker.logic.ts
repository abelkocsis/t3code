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
 * The thread's first message.
 *
 * It hands over the issues and then explicitly holds the agent back, because
 * the instruction that follows is the user's own and they have not written it
 * yet. Without the hold, a capable agent reads a bug report as a request to
 * fix it and starts editing before anyone has agreed what to do.
 */
export function buildIssueSeedMessage(issues: ReadonlyArray<SourceControlIssueDetail>): string {
  const plural = issues.length === 1 ? "this issue" : "these issues";
  const sections = issues.map((issue) => {
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
  });
  return [
    `We are going to work on ${plural}. Read them, then tell me what you understand and anything that looks unclear.`,
    "",
    "Do not change any files and do not start the work yet. My next message says what to do.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}
