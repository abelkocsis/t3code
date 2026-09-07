import * as Schema from "effect/Schema";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  /** Present when the provider can tell that an open change request is still a draft. */
  isDraft: Schema.optional(Schema.Boolean),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    cwd: Schema.String,
    command: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String),
    reference: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}

/**
 * The most issue rows one search may return. GitHub's own search pages at a
 * hundred, and a picker that shows more than this is a list nobody reads.
 */
export const SOURCE_CONTROL_ISSUE_SEARCH_MAX_ROWS = 100;

/** How many characters of an issue body a search row carries. */
export const SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH = 280;

export const SourceControlIssueState = Schema.Literals(["open", "closed"]);
export type SourceControlIssueState = typeof SourceControlIssueState.Type;

/** Six hex digits without the leading `#`, as every host reports them. */
export const SourceControlIssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: TrimmedString,
});
export type SourceControlIssueLabel = typeof SourceControlIssueLabel.Type;

/** A repository in `owner/name` form plus the number that identifies an issue in it. */
export const SourceControlIssueRef = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type SourceControlIssueRef = typeof SourceControlIssueRef.Type;

/**
 * One row of a search. Bodies are left out on purpose: fifty issue bodies is a
 * payload nobody reading a list needs, so a row carries only `summary`, and the
 * full text arrives from `getIssues` for the few issues a user picks.
 */
export const SourceControlIssueSummary = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: SourceControlIssueState,
  labels: ForwardCompatibleArray(SourceControlIssueLabel),
  assignees: Schema.Array(TrimmedNonEmptyString),
  authorLogin: Schema.NullOr(TrimmedNonEmptyString),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** First lines of the body, bounded by SOURCE_CONTROL_ISSUE_SUMMARY_MAX_LENGTH. */
  summary: TrimmedString,
});
export type SourceControlIssueSummary = typeof SourceControlIssueSummary.Type;

/** A picked issue with the whole body, which is what seeds a thread. */
export const SourceControlIssueDetail = Schema.Struct({
  ...SourceControlIssueSummary.fields,
  body: Schema.String,
});
export type SourceControlIssueDetail = typeof SourceControlIssueDetail.Type;

/**
 * `assignedToViewer` is its own field rather than text the caller appends,
 * because the picker's filter must survive a user typing their own qualifiers
 * into `query` and must never be defeated by them.
 */
export const SourceControlIssueSearchInput = Schema.Struct({
  provider: SourceControlProviderKind,
  query: TrimmedString,
  assignedToViewer: Schema.Boolean,
  /** `owner/name` to search one repository, null to search every readable one. */
  repository: Schema.NullOr(TrimmedNonEmptyString),
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: SOURCE_CONTROL_ISSUE_SEARCH_MAX_ROWS }),
  ),
});
export type SourceControlIssueSearchInput = typeof SourceControlIssueSearchInput.Type;

export const SourceControlIssueSearchResult = Schema.Struct({
  issues: ForwardCompatibleArray(SourceControlIssueSummary),
  /** True when the host had more rows than `limit`, so the user can narrow. */
  truncated: Schema.Boolean,
});
export type SourceControlIssueSearchResult = typeof SourceControlIssueSearchResult.Type;

export const SourceControlIssueDetailsInput = Schema.Struct({
  provider: SourceControlProviderKind,
  issues: Schema.Array(SourceControlIssueRef),
});
export type SourceControlIssueDetailsInput = typeof SourceControlIssueDetailsInput.Type;

export const SourceControlIssueDetailsResult = Schema.Struct({
  issues: ForwardCompatibleArray(SourceControlIssueDetail),
});
export type SourceControlIssueDetailsResult = typeof SourceControlIssueDetailsResult.Type;

export class SourceControlIssueError extends Schema.TaggedErrorClass<SourceControlIssueError>()(
  "SourceControlIssueError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control issue operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}
