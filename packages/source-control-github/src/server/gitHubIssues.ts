import type * as Cause from "effect/Cause";
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
import type { SourceControlIssueSearchBatch } from "@t3tools/source-control-core/server/SourceControlProvider";

export interface GitHubIssueSearchQueryInput {
  readonly query: string;
  readonly assignedToViewer: boolean;
  readonly repository: string | null;
}

/**
 * The `q` of one `GET search/issues` call.
 *
 * Only open issues: this search exists to start work, and a closed issue is
 * not work. `is:issue` leaves pull requests out, which the search endpoint
 * otherwise mixes in; the decoder drops any that arrive anyway. The user's
 * own text comes last, so a qualifier they type cannot be read as the
 * filter's value.
 */
export function buildGitHubIssueSearchQuery(input: GitHubIssueSearchQueryInput): string {
  const parts = ["is:issue", "is:open"];
  if (input.assignedToViewer) {
    parts.push("assignee:@me");
  }
  const repository = input.repository?.trim() ?? "";
  if (repository.length > 0) {
    parts.push(`repo:${repository}`);
  }
  const query = input.query.trim();
  if (query.length > 0) {
    parts.push(query);
  }
  return parts.join(" ");
}

/** The REST path of one search, most recently updated first. */
export function buildGitHubIssueSearchPath(
  input: GitHubIssueSearchQueryInput & { readonly limit: number },
): string {
  const params = new URLSearchParams({
    q: buildGitHubIssueSearchQuery(input),
    sort: "updated",
    order: "desc",
    per_page: String(input.limit),
  });
  return `search/issues?${params.toString()}`;
}

/** The REST path of one issue's full record. */
export function buildGitHubIssueDetailPath(ref: SourceControlIssueRef): string {
  const [owner = "", name = ""] = ref.repository.split("/");
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${ref.number}`;
}

const GitHubLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The fields a search item and a single issue record share. */
const GitHubIssueSharedFields = {
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(GitHubLabelSchema)))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(GitHubActorSchema)))),
  user: Schema.optional(Schema.NullOr(GitHubActorSchema)),
  comments: Schema.optional(Schema.NullOr(NonNegativeInt)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  /** Present on a pull request, which the search endpoint lists among issues. */
  pull_request: Schema.optional(Schema.NullOr(Schema.Unknown)),
};

const GitHubIssueSearchRowSchema = Schema.Struct({
  ...GitHubIssueSharedFields,
  /** `https://api.github.com/repos/owner/name`; the only place a search row names its repository. */
  repository_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubIssueSearchResponseSchema = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
});

const GitHubIssueDetailRowSchema = Schema.Struct(GitHubIssueSharedFields);

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(value: string | null | undefined): SourceControlIssueState {
  return trimmedOrNull(value)?.toLowerCase() === "closed" ? "closed" : "open";
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

/** `owner/name` from the API URL a search row carries. */
export function repositoryFromApiUrl(url: string | null | undefined): string | null {
  const match = /\/repos\/([^/\s]+\/[^/\s]+)\/?$/u.exec(url?.trim() ?? "");
  return match?.[1] ?? null;
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

const decodeSearchResponse = decodeJsonResult(GitHubIssueSearchResponseSchema);
const decodeSearchRow = Schema.decodeUnknownExit(GitHubIssueSearchRowSchema);
const decodeDetailRow = decodeJsonResult(GitHubIssueDetailRowSchema);

function toSummary(
  row: Schema.Schema.Type<typeof GitHubIssueDetailRowSchema>,
  repository: string,
): SourceControlIssueSummary {
  return {
    repository,
    number: row.number,
    title: row.title,
    url: row.html_url,
    state: normalizeState(row.state),
    labels: normalizeLabels(row.labels),
    assignees: normalizeAssignees(row.assignees),
    authorLogin: trimmedOrNull(row.user?.login),
    commentCount: row.comments ?? 0,
    createdAt: trimmedOrNull(row.created_at) ?? "",
    updatedAt: trimmedOrNull(row.updated_at) ?? "",
    summary: summarizeIssueBody(row.body),
  };
}

/**
 * One search's rows, with anything unreadable dropped rather than failing the
 * whole list: a single issue whose shape drifts must not empty a picker.
 */
export function decodeGitHubIssueSearchJson(
  raw: string,
): Result.Result<SourceControlIssueSearchBatch, Cause.Cause<Schema.SchemaError>> {
  const response = decodeSearchResponse(raw);
  if (!Result.isSuccess(response)) return Result.fail(response.failure);
  const issues: SourceControlIssueSummary[] = [];
  for (const entry of response.success.items) {
    const decoded = decodeSearchRow(entry);
    if (Exit.isFailure(decoded)) continue;
    const row = decoded.value;
    if (row.pull_request !== undefined && row.pull_request !== null) continue;
    const repository = repositoryFromApiUrl(row.repository_url);
    if (repository === null) continue;
    issues.push(toSummary(row, repository));
  }
  return Result.succeed({ issues, rawCount: response.success.items.length });
}

/**
 * One issue's full body. The record was read from a repository the caller
 * named, so the reference supplies what the payload leaves out.
 */
export function decodeGitHubIssueDetailJson(
  raw: string,
  ref: SourceControlIssueRef,
): Result.Result<SourceControlIssueDetail, Cause.Cause<Schema.SchemaError>> {
  const decoded = decodeDetailRow(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const row = decoded.success;
  return Result.succeed({ ...toSummary(row, ref.repository), body: row.body ?? "" });
}
