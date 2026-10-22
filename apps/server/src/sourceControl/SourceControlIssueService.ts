import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  SourceControlIssueError,
  SourceControlProviderError,
  type SourceControlIssueDetailsInput,
  type SourceControlIssueDetailsResult,
  type SourceControlIssueSearchInput,
  type SourceControlIssueSearchResult,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const isSourceControlIssueError = Schema.is(SourceControlIssueError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);

/**
 * Issue search for the pickers that start work from an issue.
 *
 * A host joins in by implementing the optional issue methods on its provider.
 * One that has not fails with a sentence a user can act on rather than
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
        ? "Choose a source control host before searching for issues."
        : `Issue search is not available for ${provider}.`,
  });
}

/**
 * A provider failure already carries a sentence written for a user — that
 * the host is not signed in, rate limited, or cannot find the repository — so
 * the detail is kept rather than replaced with a generic one.
 */
function mapIssueError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) => {
    if (isSourceControlIssueError(cause)) return cause;
    const detail = isSourceControlProviderError(cause)
      ? cause.detail
      : "The issue lookup could not be completed.";
    return new SourceControlIssueError({ operation, provider, detail, cause });
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const searchIssues = Effect.fn("SourceControlIssueService.searchIssues")(
    function* (input: SourceControlIssueSearchInput) {
      const provider = yield* registry.get(input.provider);
      if (provider.searchIssues === undefined) {
        return yield* unsupported("searchIssues", input.provider);
      }
      const batch = yield* provider.searchIssues({
        // No project is chosen yet when this runs, so the search stands in
        // the server's own directory; the host does not scope a search by it.
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
    },
    (effect, input) => effect.pipe(mapIssueError("searchIssues", input.provider)),
  );

  const getIssueDetails = Effect.fn("SourceControlIssueService.getIssueDetails")(
    function* (input: SourceControlIssueDetailsInput) {
      const provider = yield* registry.get(input.provider);
      const getIssue = provider.getIssue;
      if (getIssue === undefined) {
        return yield* unsupported("getIssueDetails", input.provider);
      }
      // Sequential rather than concurrent: a handful of issues at a time, and
      // the host shares one rate-limit budget with everything else here.
      const issues = yield* Effect.forEach(input.issues, (issue) =>
        getIssue({ cwd: config.cwd, issue }),
      );
      return { issues };
    },
    (effect, input) => effect.pipe(mapIssueError("getIssueDetails", input.provider)),
  );

  return SourceControlIssueService.of({ searchIssues, getIssueDetails });
});

export const layer = Layer.effect(SourceControlIssueService, make);
