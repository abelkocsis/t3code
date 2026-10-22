import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ForkThreadState,
  type ThreadFactory,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewRequestMessage,
  collectFactoryTasks,
  countFactoryTasksWaiting,
  factoryJoinState,
  factoryProgress,
  factoryTaskKey,
  factoryTaskState,
  formatElapsed,
  isReReviewRequest,
  moveFactoryTask,
  orderFactoryTasks,
  projectRepositorySlug,
  resolveFactoryProject,
} from "./factory.logic";

const NOW = "2026-10-14T10:00:00.000Z";
const ENV = EnvironmentId.make("env-1");

function factory(overrides: Partial<ThreadFactory> = {}): ThreadFactory {
  return {
    input: { kind: "free-text", value: "Add a range cap" },
    phase: "implementation",
    summary: null,
    startedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: ENV,
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Task",
    pullRequests: [],
    latestRun: null,
    runtime: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

const running = { status: "running" } as EnvironmentThreadShell["runtime"];

/** The fork rows for a list of threads, each flagged with the given factory state. */
function states(
  entries: ReadonlyArray<readonly [EnvironmentThreadShell, ThreadFactory | null]>,
): ReadonlyMap<string, ForkThreadState> {
  return new Map(
    entries.map(([shell, state]) => [
      scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)),
      { threadId: shell.id, folderId: null, factory: state, slackThread: null, updatedAt: NOW },
    ]),
  );
}

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENV,
    id: ProjectId.make("project-1"),
    title: "omnibus",
    workspaceRoot: "/repos/omnibus",
    createdAt: NOW,
    updatedAt: NOW,
    repositoryIdentity: {
      canonicalKey: "github.com/dlc-link/omnibus",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:DLC-link/omnibus.git",
      },
    },
    ...overrides,
  } as EnvironmentProject;
}

const pullRequest = (snapshot: { state: string; title?: string } | null) =>
  ({
    host: "github.com",
    repository: "acme/web",
    number: 9,
    url: "https://github.com/acme/web/pull/9",
    source: "agent",
    linkedAt: NOW,
    snapshot,
    stack: null,
  }) as EnvironmentThreadShell["pullRequests"][number];

describe("factoryProgress", () => {
  const stageOf = (overrides: Partial<ThreadFactory>, hasPullRequest = false) =>
    factoryProgress({
      factory: factory(overrides),
      pullRequest: hasPullRequest ? pullRequest(null) : null,
    });

  it("places a fix in the review it answers", () => {
    expect(stageOf({ phase: "fix" }).stage).toBe(2);
    expect(stageOf({ phase: "fix" }, true).stage).toBe(3);
    expect(stageOf({ phase: "fix", reviewRound: 1 }, true).stage).toBe(4);
  });

  it("keeps the stage a human gate interrupted", () => {
    expect(stageOf({ phase: "human-gate", gatedFrom: "implementation" })).toEqual({
      stage: 1,
      gated: true,
      complete: false,
    });
    expect(stageOf({ phase: "human-gate" }).stage).toBeNull();
  });

  it("fills the bar only once merged", () => {
    expect(stageOf({ phase: "ready-to-merge" })).toMatchObject({ stage: 5, complete: false });
    expect(stageOf({ phase: "merged" })).toMatchObject({ stage: 5, complete: true });
  });
});

describe("factoryTaskState", () => {
  it("puts a human gate first", () => {
    expect(
      factoryTaskState(thread({ hasPendingUserInput: true, runtime: running }), factory()),
    ).toBe("waiting");
  });

  it("waits on the human at a human gate once the agent stops", () => {
    expect(factoryTaskState(thread(), factory({ phase: "human-gate" }))).toBe("waiting");
    expect(factoryTaskState(thread({ runtime: running }), factory({ phase: "human-gate" }))).toBe(
      "working",
    );
  });

  it("reads background work as working, also under review", () => {
    expect(
      factoryTaskState(
        thread({ pendingBackgroundTasks: [{ taskId: "ci", kind: "monitor" }] as never }),
        factory({ phase: "under-review" }),
      ),
    ).toBe("working");
  });

  it("reads working, done, and error", () => {
    expect(factoryTaskState(thread({ runtime: running }), factory())).toBe("working");
    expect(factoryTaskState(thread(), factory({ phase: "done" }))).toBe("done");
    expect(
      factoryTaskState(
        thread({ latestRun: { status: "failed" } as EnvironmentThreadShell["latestRun"] }),
        factory(),
      ),
    ).toBe("error");
    expect(factoryTaskState(thread(), factory())).toBe("working");
  });

  it("waits on the human when token saving held review work", () => {
    const held = factory({
      phase: "under-review",
      pendingWork: { summary: "CI failed.", message: "Fix CI." },
    });
    expect(factoryTaskState(thread(), held)).toBe("waiting");
    expect(factoryTaskState(thread(), factory({ phase: "under-review" }))).toBe("idle");
  });

  it("treats a snoozed task as parked, not waiting", () => {
    const wake = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    expect(
      factoryTaskState(
        thread({ hasPendingUserInput: true, snoozedUntil: wake }),
        factory(),
        Date.parse(NOW),
      ),
    ).toBe("snoozed");
  });

  it("waits on the human for review stages and finishes on merge", () => {
    expect(factoryTaskState(thread(), factory({ phase: "ready-for-review" }))).toBe("waiting");
    expect(
      factoryTaskState(thread({ runtime: running }), factory({ phase: "ready-for-review" })),
    ).toBe("working");
    expect(factoryTaskState(thread(), factory({ phase: "under-review" }))).toBe("idle");
    expect(factoryTaskState(thread(), factory({ phase: "ready-to-merge" }))).toBe("waiting");
    expect(factoryTaskState(thread(), factory({ phase: "merged" }))).toBe("done");
    expect(
      factoryTaskState(
        thread({ pullRequests: [pullRequest({ state: "open" })] }),
        factory({ phase: "done" }),
      ),
    ).toBe("waiting");
  });
});

describe("collectFactoryTasks", () => {
  it("lists only unarchived flagged threads, waiting first then newest", () => {
    const plain = thread({ id: ThreadId.make("plain") });
    const archived = thread({ id: ThreadId.make("archived"), archivedAt: NOW });
    const old = thread({ id: ThreadId.make("old") });
    const fresh = thread({ id: ThreadId.make("new") });
    const gate = thread({ id: ThreadId.make("gate"), hasPendingApprovals: true });
    const tasks = collectFactoryTasks(
      [plain, archived, old, fresh, gate],
      states([
        [plain, null],
        [archived, factory()],
        [old, factory({ startedAt: "2026-10-13T10:00:00.000Z" })],
        [fresh, factory()],
        [gate, factory()],
      ]),
    );
    expect(tasks.map((task) => task.thread.id)).toEqual(["gate", "new", "old"]);
  });

  it("takes the open pull request link", () => {
    const linked = thread({ pullRequests: [pullRequest(null)] });
    const [task] = collectFactoryTasks([linked], states([[linked, factory()]]));
    expect(task?.pullRequest?.url).toBe("https://github.com/acme/web/pull/9");
  });

  it("counts the tasks that wait on the human", () => {
    const a = thread({ id: ThreadId.make("a"), hasPendingUserInput: true });
    const b = thread({ id: ThreadId.make("b") });
    const c = thread({ id: ThreadId.make("c"), hasPendingApprovals: true, archivedAt: NOW });
    expect(
      countFactoryTasksWaiting(
        collectFactoryTasks(
          [a, b, c],
          states([
            [a, factory()],
            [b, factory()],
            [c, factory()],
          ]),
        ),
      ),
    ).toBe(1);
  });
});

describe("orderFactoryTasks", () => {
  it("applies the dragged order and keeps the rest behind it", () => {
    const a = thread({ id: ThreadId.make("a") });
    const b = thread({ id: ThreadId.make("b") });
    const c = thread({ id: ThreadId.make("c") });
    const tasks = collectFactoryTasks(
      [a, b, c],
      states([
        [a, factory()],
        [b, factory()],
        [c, factory()],
      ]),
    );
    const ordered = orderFactoryTasks(tasks, ["env-1:c", "env-1:a"]);
    expect(ordered.map(factoryTaskKey)).toEqual(["env-1:c", "env-1:a", "env-1:b"]);
    expect(moveFactoryTask(ordered, "env-1:b", "env-1:c")).toEqual([
      "env-1:b",
      "env-1:c",
      "env-1:a",
    ]);
  });
});

describe("resolveFactoryProject", () => {
  it("reads the repository slug from ssh and https remotes", () => {
    expect(projectRepositorySlug(project())).toBe("dlc-link/omnibus");
    expect(
      projectRepositorySlug(
        project({
          repositoryIdentity: {
            canonicalKey: "x",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/DLC-link/Omnibus",
            },
          } as never,
        }),
      ),
    ).toBe("dlc-link/omnibus");
    expect(projectRepositorySlug(project({ repositoryIdentity: null }))).toBeNull();
  });

  it("maps a GitHub issue to the project with that remote", () => {
    const omnibus = project();
    const other = project({
      id: ProjectId.make("project-2"),
      title: "other",
      repositoryIdentity: null,
    });
    expect(
      resolveFactoryProject(
        { kind: "github-issue", value: "https://github.com/DLC-link/omnibus/issues/54" },
        [other, omnibus],
      ),
    ).toEqual({ kind: "resolved", project: omnibus });
  });

  it("asks when the issue repository matches no project", () => {
    const result = resolveFactoryProject(
      { kind: "github-issue", value: "https://github.com/acme/nothing/issues/1" },
      [project()],
    );
    expect(result.kind).toBe("ask");
  });

  it("maps free text by repository name and asks otherwise", () => {
    const omnibus = project();
    const attestor = project({
      id: ProjectId.make("project-2"),
      title: "attestor",
      repositoryIdentity: {
        canonicalKey: "y",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:DLC-link/attestor.git",
        },
      } as never,
    });
    expect(
      resolveFactoryProject(
        { kind: "free-text", value: "Add a range cap to omnibus holders route" },
        [omnibus, attestor],
      ),
    ).toEqual({ kind: "resolved", project: omnibus });
    const ask = resolveFactoryProject({ kind: "free-text", value: "Fix the thing" }, [
      omnibus,
      attestor,
    ]);
    expect(ask.kind).toBe("ask");
    if (ask.kind === "ask") expect(ask.candidates).toHaveLength(2);
  });

  it("lists every project when free text matches several, matches first", () => {
    const omnibus = project();
    const admin = project({ id: ProjectId.make("project-2"), title: "admin" });
    const attestorAdmin = project({ id: ProjectId.make("project-3"), title: "attestor-admin" });
    const result = resolveFactoryProject(
      { kind: "free-text", value: "Add a health check to attestor-admin" },
      [omnibus, admin, attestorAdmin],
    );
    expect(result).toEqual({ kind: "ask", candidates: [admin, attestorAdmin, omnibus] });
  });
});

describe("buildReviewRequestMessage", () => {
  it("asks for a first review or a re-review", () => {
    expect(buildReviewRequestMessage(["https://x/pull/1"])).toBe(
      "Please, review following PRs:\n- https://x/pull/1",
    );
    expect(buildReviewRequestMessage(["https://x/pull/1"], { reReview: true })).toBe(
      "Fixed following PRs, please, review again:\n- https://x/pull/1",
    );
    const task = thread();
    const withFactory = (state: ThreadFactory) =>
      collectFactoryTasks([task], states([[task, state]]));
    expect(isReReviewRequest(withFactory(factory({ phase: "ready-for-review" })))).toBe(false);
    expect(
      isReReviewRequest(withFactory(factory({ phase: "ready-for-review", reviewRound: 1 }))),
    ).toBe(true);
    // Under review, the current round is the one the request went out for.
    expect(isReReviewRequest(withFactory(factory({ phase: "under-review", reviewRound: 1 })))).toBe(
      false,
    );
    expect(isReReviewRequest(withFactory(factory({ phase: "under-review", reviewRound: 2 })))).toBe(
      true,
    );
  });
});

describe("formatElapsed", () => {
  it("formats minutes, hours, and days", () => {
    const start = Date.parse(NOW);
    expect(formatElapsed(NOW, start + 5 * 60_000)).toBe("5m");
    expect(formatElapsed(NOW, start + 3 * 3_600_000 + 60_000)).toBe("3h");
    expect(formatElapsed(NOW, start + 72 * 3_600_000)).toBe("3d");
  });
});

describe("factoryJoinState", () => {
  const linked = (snapshot: { state: string; title?: string } | null) =>
    thread({ pullRequests: [pullRequest(snapshot)] });

  it("puts a thread with an open pull request straight into ready for review", () => {
    const joined = factoryJoinState(linked({ state: "open", title: "Add a cap" }), NOW);
    expect(joined.askAgent).toBe(false);
    expect(joined.factory).toMatchObject({
      input: { kind: "pull-request", value: "https://github.com/acme/web/pull/9" },
      phase: "ready-for-review",
      summary: "Add a cap",
    });
  });

  it("treats a pull request the sync has not read yet as ready for review", () => {
    expect(factoryJoinState(linked(null), NOW).factory.phase).toBe("ready-for-review");
  });

  it("files a merged or closed pull request as finished", () => {
    expect(factoryJoinState(linked({ state: "merged" }), NOW).factory.phase).toBe("merged");
    expect(factoryJoinState(linked({ state: "closed" }), NOW).factory.phase).toBe("done");
  });

  it("asks the agent for the phase when no pull request is linked", () => {
    const joined = factoryJoinState(thread({ title: "Fix the cap" }), NOW);
    expect(joined.askAgent).toBe(true);
    expect(joined.factory.input).toEqual({ kind: "free-text", value: "Fix the cap" });
  });
});
