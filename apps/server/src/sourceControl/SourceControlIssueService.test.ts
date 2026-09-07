import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SourceControlIssueSummary } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as SourceControlIssueService from "./SourceControlIssueService.ts";
import type { GitHubIssueSearchBatch } from "./gitHubIssues.ts";

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

function makeService(github: Partial<GitHubCli.GitHubCli["Service"]>) {
  return SourceControlIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubCli.GitHubCli)(github),
        // Only `cwd` is read here, but the config is built the way the server
        // builds it rather than faked, so a change to its shape is caught.
        ServerConfig.layerTest("/tmp/t3-issue-service", { prefix: "t3-issue-service" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

const batch = (issues: ReadonlyArray<SourceControlIssueSummary>, rawCount?: number) =>
  ({ issues, rawCount: rawCount ?? issues.length }) satisfies GitHubIssueSearchBatch;

it.effect("passes the filter and the scope through to the CLI", () =>
  Effect.gen(function* () {
    let seen: unknown = null;
    const service = yield* makeService({
      searchIssues: (input) => {
        seen = input;
        return Effect.succeed(batch([issue(1)]));
      },
    });
    const result = yield* service.searchIssues({
      provider: "github",
      query: "reconnect",
      assignedToViewer: true,
      repository: "cli/cli",
      limit: 30,
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
    const service = yield* makeService({
      searchIssues: () => Effect.succeed(batch([issue(1), issue(2)])),
    });
    const result = yield* service.searchIssues({
      provider: "github",
      query: "",
      assignedToViewer: false,
      repository: null,
      limit: 2,
    });
    assert.isTrue(result.truncated);
  }),
);

it.effect("counts dropped rows towards the page, since a filtered page is still full", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      // Two rows came back and one survived filtering. There is still more
      // behind the page, so a count of the survivors would say otherwise.
      searchIssues: () => Effect.succeed(batch([issue(1)], 2)),
    });
    const result = yield* service.searchIssues({
      provider: "github",
      query: "",
      assignedToViewer: false,
      repository: null,
      limit: 2,
    });
    assert.isTrue(result.truncated);
    assert.lengthOf(result.issues, 1);
  }),
);

it.effect("leaves a partial page alone", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      searchIssues: () => Effect.succeed(batch([issue(1)])),
    });
    const result = yield* service.searchIssues({
      provider: "github",
      query: "",
      assignedToViewer: false,
      repository: null,
      limit: 30,
    });
    assert.isFalse(result.truncated);
  }),
);

it.effect("refuses a host it cannot search rather than reporting no issues", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      searchIssues: () => Effect.die("the CLI must not be reached for GitLab"),
    });
    const error = yield* service
      .searchIssues({
        provider: "gitlab",
        query: "",
        assignedToViewer: true,
        repository: null,
        limit: 30,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.provider, "gitlab");
    assert.strictEqual(error.detail, "Issue search is only available for GitHub.");
  }),
);

it.effect("asks for a provider when none is chosen yet", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      searchIssues: () => Effect.die("the CLI must not be reached without a provider"),
    });
    const error = yield* service
      .searchIssues({
        provider: "unknown",
        query: "",
        assignedToViewer: true,
        repository: null,
        limit: 30,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.detail, "Choose GitHub before searching for issues.");
  }),
);

it.effect("keeps the CLI's own sentence, which already tells the user what to do", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      searchIssues: (input) =>
        Effect.fail(
          new GitHubCli.GitHubCliAuthenticationError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("gh auth"),
          }),
        ),
    });
    const error = yield* service
      .searchIssues({
        provider: "github",
        query: "",
        assignedToViewer: true,
        repository: null,
        limit: 30,
      })
      .pipe(Effect.flip);
    assert.strictEqual(
      error.detail,
      "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
    );
    assert.strictEqual(error.operation, "searchIssues");
  }),
);

it.effect("reads every picked issue, in the order they were picked", () =>
  Effect.gen(function* () {
    const asked: number[] = [];
    const service = yield* makeService({
      getIssue: (input) => {
        asked.push(input.number);
        return Effect.succeed({ ...issue(input.number), body: `body ${input.number}` });
      },
    });
    const result = yield* service.getIssueDetails({
      provider: "github",
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
