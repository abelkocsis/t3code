import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type SourceControlIssueSummary,
} from "@t3tools/contracts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as ServerConfig from "../config.ts";
import * as SourceControlIssueService from "./SourceControlIssueService.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

function issue(number: number): SourceControlIssueSummary {
  return {
    repository: "cli/cli",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/cli/cli/issues/${number}`,
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

type Provider = SourceControlProvider.SourceControlProvider["Service"];

/** A provider that answers only the issue methods given; anything else is a test bug. */
function makeProvider(
  kind: string,
  issues: Pick<Provider, "searchIssues" | "getIssue"> = {},
): Provider {
  const unexpected = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;
  return {
    kind: SourceControlProviderKind.make(kind),
    listChangeRequests: () => unexpected("listChangeRequests"),
    getChangeRequest: () => unexpected("getChangeRequest"),
    createChangeRequest: () => unexpected("createChangeRequest"),
    getRepositoryCloneUrls: () => unexpected("getRepositoryCloneUrls"),
    createRepository: () => unexpected("createRepository"),
    getDefaultBranch: () => unexpected("getDefaultBranch"),
    checkoutChangeRequest: () => unexpected("checkoutChangeRequest"),
    ...issues,
  };
}

function makeService(providers: ReadonlyArray<Provider>) {
  return SourceControlIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          get: (kind) =>
            Effect.succeed(
              providers.find((provider) => provider.kind === kind) ?? makeProvider(kind),
            ),
        }),
        // Only `cwd` is read here, but the config is built the way the server
        // builds it rather than faked, so a change to its shape is caught.
        ServerConfig.layerTest("/tmp/t3-issue-service", { prefix: "t3-issue-service" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

const batch = (issues: ReadonlyArray<SourceControlIssueSummary>, rawCount?: number) => ({
  issues,
  rawCount: rawCount ?? issues.length,
});

const SEARCH = {
  provider: SourceControlProviderKind.make("github"),
  query: "",
  assignedToViewer: false,
  repository: null,
  limit: 30,
};

it.effect("passes the filter and the scope through to the host", () =>
  Effect.gen(function* () {
    let seen: unknown = null;
    const service = yield* makeService([
      makeProvider("github", {
        searchIssues: (input) => {
          seen = input;
          return Effect.succeed(batch([issue(1)]));
        },
      }),
    ]);
    const result = yield* service.searchIssues({
      ...SEARCH,
      query: "reconnect",
      assignedToViewer: true,
      repository: "cli/cli",
    });
    assert.deepStrictEqual(result.issues, [issue(1)]);
    assert.include(seen as object, {
      query: "reconnect",
      assignedToViewer: true,
      repository: "cli/cli",
      limit: 30,
    });
  }),
);

it.effect("reports a full page as truncated so the user knows to narrow the search", () =>
  Effect.gen(function* () {
    const service = yield* makeService([
      makeProvider("github", { searchIssues: () => Effect.succeed(batch([issue(1), issue(2)])) }),
    ]);
    const result = yield* service.searchIssues({ ...SEARCH, limit: 2 });
    assert.isTrue(result.truncated);
  }),
);

it.effect("counts dropped rows towards the page, since a filtered page is still full", () =>
  Effect.gen(function* () {
    const service = yield* makeService([
      // Two rows came back and one survived filtering. There is still more
      // behind the page, so a count of the survivors would say otherwise.
      makeProvider("github", { searchIssues: () => Effect.succeed(batch([issue(1)], 2)) }),
    ]);
    const result = yield* service.searchIssues({ ...SEARCH, limit: 2 });
    assert.isTrue(result.truncated);
    assert.lengthOf(result.issues, 1);
  }),
);

it.effect("leaves a partial page alone", () =>
  Effect.gen(function* () {
    const service = yield* makeService([
      makeProvider("github", { searchIssues: () => Effect.succeed(batch([issue(1)])) }),
    ]);
    const result = yield* service.searchIssues(SEARCH);
    assert.isFalse(result.truncated);
  }),
);

it.effect("refuses a host without issue search rather than reporting no issues", () =>
  Effect.gen(function* () {
    const service = yield* makeService([makeProvider("gitlab")]);
    const error = yield* service
      .searchIssues({ ...SEARCH, provider: SourceControlProviderKind.make("gitlab") })
      .pipe(Effect.flip);
    assert.strictEqual(error.provider, "gitlab");
    assert.strictEqual(error.detail, "Issue search is not available for gitlab.");
  }),
);

it.effect("asks for a host when none is chosen yet", () =>
  Effect.gen(function* () {
    const service = yield* makeService([]);
    const error = yield* service
      .searchIssues({ ...SEARCH, provider: SourceControlProviderKind.make("unknown") })
      .pipe(Effect.flip);
    assert.strictEqual(error.detail, "Choose a source control host before searching for issues.");
  }),
);

it.effect("keeps the host's own sentence, which already tells the user what to do", () =>
  Effect.gen(function* () {
    const service = yield* makeService([
      makeProvider("github", {
        searchIssues: (input) =>
          Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation: "searchIssues",
              cwd: input.cwd,
              detail:
                "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
            }),
          ),
      }),
    ]);
    const error = yield* service.searchIssues(SEARCH).pipe(Effect.flip);
    assert.strictEqual(
      error.detail,
      "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
    );
    assert.strictEqual(error.operation, "searchIssues");
  }),
);

it.effect("reads every picked issue, in the order they were picked", () =>
  Effect.gen(function* () {
    const asked: number[] = [];
    const service = yield* makeService([
      makeProvider("github", {
        getIssue: ({ issue: ref }) => {
          asked.push(ref.number);
          return Effect.succeed({ ...issue(ref.number), body: `body ${ref.number}` });
        },
      }),
    ]);
    const result = yield* service.getIssueDetails({
      provider: SourceControlProviderKind.make("github"),
      issues: [
        { repository: "cli/cli", number: 7 },
        { repository: "cli/cli", number: 3 },
      ],
    });
    assert.deepStrictEqual(asked, [7, 3]);
    assert.deepStrictEqual(
      result.issues.map((each) => each.body),
      ["body 7", "body 3"],
    );
  }),
);
