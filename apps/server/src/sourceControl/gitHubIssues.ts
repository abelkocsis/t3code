import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH,
  TrimmedNonEmptyString,
  type SourceControlIssueDetail,
  type SourceControlIssueRef,
  type SourceControlIssueState,
  type SourceControlIssueSummary,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * The fields both `gh search issues` and `gh issue view` are asked for. Bodies
 * ride along because the row preview is cut from them here, on the server: the
 * whole text crosses a pipe on this machine, and only the preview crosses the
 * websocket.
 */
const SEARCH_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "repository",
  "labels",
  "assignees",
  "commentsCount",
  "createdAt",
  "updatedAt",
  "state",
  "author",
  "isPullRequest",
  "body",
] as const;

const DETAIL_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "labels",
  "assignees",
  "createdAt",
  "updatedAt",
  "state",
  "author",
  "body",
] as const;

export interface GitHubIssueSearchArgsInput {
  readonly query: string;
  readonly assignedToViewer: boolean;
  readonly repository: string | null;
  readonly limit: number;
}

/**
 * The `gh search issues` argv for one search.
 *
 * Only open issues: this search exists to start work, and a closed issue is
 * not work. Pull requests are left out because `gh` excludes them unless
 * `--include-prs` is passed, and the decoder drops any that arrive anyway.
 *
 * A free-text query goes after `--` so that a term beginning with a hyphen —
 * which GitHub's own search syntax uses for negation — reaches `gh` as a term
 * rather than as an unknown flag.
 */
export function buildGitHubIssueSearchArgs(
  input: GitHubIssueSearchArgsInput,
): ReadonlyArray<string> {
  const args = [
    "search",
    "issues",
    "--state",
    "open",
    "--sort",
    "updated",
    "--limit",
    String(input.limit),
    "--json",
    SEARCH_JSON_FIELDS.join(","),
  ];
  if (input.assignedToViewer) {
    args.push("--assignee", "@me");
  }
  const repository = input.repository?.trim() ?? "";
  if (repository.length > 0) {
    args.push("--repo", repository);
  }
  const query = input.query.trim();
  if (query.length > 0) {
    args.push("--", query);
  }
  return args;
}

/** The `gh issue view` argv for one issue's full body. */
export function buildGitHubIssueDetailArgs(ref: SourceControlIssueRef): ReadonlyArray<string> {
  return [
    "issue",
    "view",
    String(ref.number),
    "--repo",
    ref.repository,
    "--json",
    DETAIL_JSON_FIELDS.join(","),
  ];
}

const GitHubLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueSharedFields = {
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(GitHubLabelSchema)))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(GitHubActorSchema)))),
  author: Schema.optional(Schema.NullOr(GitHubActorSchema)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
};

const GitHubIssueSearchRowSchema = Schema.Struct({
  ...GitHubIssueSharedFields,
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  commentsCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
  isPullRequest: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const GitHubIssueDetailRowSchema = Schema.Struct(GitHubIssueSharedFields);

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(value: string | null | undefined): SourceControlIssueState {
  return trimmedOrNull(value)?.toUpperCase() === "CLOSED" ? "closed" : "open";
}

function normalizeLabels(
  raw: Schema.Schema.Type<typeof GitHubIssueSharedFields.labels> | undefined,
): SourceControlIssueSummary["labels"] {
  return (raw ?? []).flatMap((label) => {
    const name = trimmedOrNull(label?.name);
    // A colour is decoration; a name is the label. Keep the row either way.
    return name === null ? [] : [{ name, color: trimmedOrNull(label?.color) ?? "" }];
  });
}

function normalizeAssignees(
  raw: Schema.Schema.Type<typeof GitHubIssueSharedFields.assignees> | undefined,
): ReadonlyArray<string> {
  return (raw ?? []).flatMap((assignee) => {
    const login = trimmedOrNull(assignee?.login);
    return login === null ? [] : [login];
  });
}

/**
 * The first prose of an issue body as one line.
 *
 * Markdown structure is stripped rather than rendered: a picker row is a
 * single line of plain text, and a heading marker or a table pipe reaching it
 * reads as noise. Anything past the bound is cut on a word where one is near,
 * so the preview does not end mid-word.
 */
export function summarizeIssueBody(body: string | null | undefined): string {
  const collapsed = (body ?? "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/[#>*_`|-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (collapsed.length <= SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH) return collapsed;
  const cut = collapsed.slice(0, SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const decodeSearchRows = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeSearchRow = Schema.decodeUnknownExit(GitHubIssueSearchRowSchema);
const decodeDetailRow = decodeJsonResult(GitHubIssueDetailRowSchema);

export interface GitHubIssueSearchBatch {
  readonly issues: ReadonlyArray<SourceControlIssueSummary>;
  /**
   * Rows the host returned, before pull requests and unreadable rows were
   * dropped. The caller compares it against the limit it asked for, which a
   * filtered count could not answer.
   */
  readonly rawCount: number;
}

/**
 * One search's rows, with anything unreadable dropped rather than failing the
 * whole list: a single issue whose shape drifts must not empty a picker.
 */
export function decodeGitHubIssueSearchJson(
  raw: string,
): Result.Result<GitHubIssueSearchBatch, Cause.Cause<Schema.SchemaError>> {
  const rows = decodeSearchRows(raw);
  if (!Result.isSuccess(rows)) return Result.fail(rows.failure);
  const issues: SourceControlIssueSummary[] = [];
  for (const entry of rows.success) {
    const decoded = decodeSearchRow(entry);
    if (Exit.isFailure(decoded)) continue;
    const row = decoded.value;
    if (row.isPullRequest === true) continue;
    const repository = trimmedOrNull(row.repository?.nameWithOwner);
    if (repository === null) continue;
    issues.push({
      repository,
      number: row.number,
      title: row.title,
      url: row.url,
      state: normalizeState(row.state),
      labels: normalizeLabels(row.labels),
      assignees: normalizeAssignees(row.assignees),
      authorLogin: trimmedOrNull(row.author?.login),
      commentCount: row.commentsCount ?? 0,
      createdAt: trimmedOrNull(row.createdAt) ?? "",
      updatedAt: trimmedOrNull(row.updatedAt) ?? "",
      summary: summarizeIssueBody(row.body),
    });
  }
  return Result.succeed({ issues, rawCount: rows.success.length });
}

/**
 * One issue's full body. `gh issue view` is asked for a repository it was
 * already given, so the reference supplies what the payload leaves out.
 */
export function decodeGitHubIssueDetailJson(
  raw: string,
  ref: SourceControlIssueRef,
): Result.Result<SourceControlIssueDetail, Cause.Cause<Schema.SchemaError>> {
  const decoded = decodeDetailRow(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const row = decoded.success;
  const body = row.body ?? "";
  return Result.succeed({
    repository: ref.repository,
    number: row.number,
    title: row.title,
    url: row.url,
    state: normalizeState(row.state),
    labels: normalizeLabels(row.labels),
    assignees: normalizeAssignees(row.assignees),
    authorLogin: trimmedOrNull(row.author?.login),
    commentCount: 0,
    createdAt: trimmedOrNull(row.createdAt) ?? "",
    updatedAt: trimmedOrNull(row.updatedAt) ?? "",
    summary: summarizeIssueBody(body),
    body,
  });
}
