import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  SourceControlIssueError,
  type SourceControlIssueDetailsInput,
  type SourceControlIssueDetailsResult,
  type SourceControlIssueSearchInput,
  type SourceControlIssueSearchResult,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitHubCli from "./GitHubCli.ts";

const isSourceControlIssueError = Schema.is(SourceControlIssueError);

/**
 * Issue search for the pickers that start work from an issue.
 *
 * GitHub only, on purpose. Every host names and shapes issues differently, and
 * inventing one shared model before a second host needs it would be guessing.
 * The other providers fail with a sentence a user can act on rather than
 * returning an empty list they would read as "no issues".
 */
export class SourceControlIssueService extends Context.Service<
  SourceControlIssueService,
  {
    readonly searchIssues: (
      input: SourceControlIssueSearchInput,
    ) => Effect.Effect<SourceControlIssueSearchResult, SourceControlIssueError>;
    readonly getIssueDetails: (
      input: SourceControlIssueDetailsInput,
    ) => Effect.Effect<SourceControlIssueDetailsResult, SourceControlIssueError>;
  }
>()("t3/sourceControl/SourceControlIssueService") {}

function unsupported(operation: string, provider: SourceControlProviderKind) {
  return new SourceControlIssueError({
    operation,
    provider,
    detail:
      provider === "unknown"
        ? "Choose GitHub before searching for issues."
        : "Issue search is only available for GitHub.",
  });
}

/**
 * `gh` failures already carry a sentence written for a user — that it is not
 * installed, not signed in, or rate limited — so the detail is kept rather
 * than replaced with a generic one.
 */
function mapIssueError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) => {
    if (isSourceControlIssueError(cause)) return cause;
    const detail =
      GitHubCli.isGitHubCliError(cause) && typeof cause.detail === "string"
        ? cause.detail
        : "The issue lookup could not be completed.";
    return new SourceControlIssueError({ operation, provider, detail, cause });
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const gitHub = yield* GitHubCli.GitHubCli;

  return SourceControlIssueService.of({
    searchIssues: (input) =>
      Effect.gen(function* () {
        if (input.provider !== "github") {
          return yield* unsupported("searchIssues", input.provider);
        }
        const batch = yield* gitHub.searchIssues({
          // No project is chosen yet when this runs, so the search stands in
          // the server's own directory. `gh search` is not scoped to a
          // repository by its working directory, only configured by it.
          cwd: config.cwd,
          query: input.query,
          assignedToViewer: input.assignedToViewer,
          repository: input.repository,
          limit: input.limit,
        });
        return {
          issues: batch.issues,
          // The host filled the page it was given, so there is more behind it.
          // Counted before filtering, since a page of pull requests that the
          // decoder dropped is still a full page.
          truncated: batch.rawCount >= input.limit,
        };
      }).pipe(mapIssueError("searchIssues", input.provider)),

    getIssueDetails: (input) =>
      Effect.gen(function* () {
        if (input.provider !== "github") {
          return yield* unsupported("getIssueDetails", input.provider);
        }
        // Sequential rather than concurrent: a handful of issues at a time, and
        // `gh` shares one rate-limit budget with everything else here.
        const issues = yield* Effect.forEach(input.issues, (ref) =>
          gitHub.getIssue({ cwd: config.cwd, repository: ref.repository, number: ref.number }),
        );
        return { issues };
      }).pipe(mapIssueError("getIssueDetails", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlIssueService, make);
