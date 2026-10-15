import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { ProjectId, ThreadId, type ThreadFactory } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewRequestMessage,
  collectFactoryTasks,
  isReReviewRequest,
  countFactoryTasksWaiting,
  factoryJoinState,
  factoryTaskKey,
  factoryAttentionLabel,
  factoryTaskState,
  formatElapsed,
  moveFactoryTask,
  orderFactoryTasks,
  projectRepositorySlug,
  resolveFactoryProject,
} from "./factory.logic";

const NOW = "2026-10-14T10:00:00.000Z";

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
    environmentId: "env-1",
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Task",
    modelSelection: { instanceId: "claude", model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    factory: factory(),
    ...overrides,
  } as EnvironmentThreadShell;
}

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: "env-1",
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

describe("factoryAttentionLabel", () => {
  it("says a task at a gate waits on the user, and names the stage otherwise", () => {
    expect(
      factoryAttentionLabel(thread({ factory: factory({ phase: "ready-for-review" }) })),
    ).toEqual({ label: "Waiting on you", waiting: true });
    expect(factoryAttentionLabel(thread({ factory: factory({ phase: "merged" }) }))).toEqual({
      label: "Merged",
      waiting: false,
    });
    expect(factoryAttentionLabel(thread({ factory: null }))).toBeNull();
  });
});

describe("factoryTaskState", () => {
  it("puts a human gate first", () => {
    expect(
      factoryTaskState(
        thread({
          hasPendingUserInput: true,
          session: { status: "running" } as EnvironmentThreadShell["session"],
        }),
      ),
    ).toBe("waiting");
  });

  it("reads working, done, and error", () => {
    expect(
      factoryTaskState(
        thread({ session: { status: "running" } as EnvironmentThreadShell["session"] }),
      ),
    ).toBe("working");
    expect(factoryTaskState(thread({ factory: factory({ phase: "done" }) }))).toBe("done");
    expect(
      factoryTaskState(
        thread({ latestTurn: { state: "error" } as EnvironmentThreadShell["latestTurn"] }),
      ),
    ).toBe("error");
    expect(factoryTaskState(thread())).toBe("working");
  });

  it("treats a snoozed task as parked, not waiting", () => {
    const wake = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    expect(
      factoryTaskState(thread({ hasPendingUserInput: true, snoozedUntil: wake }), Date.parse(NOW)),
    ).toBe("snoozed");
  });

  it("waits on the human for review stages and finishes on merge", () => {
    expect(factoryTaskState(thread({ factory: factory({ phase: "ready-for-review" }) }))).toBe(
      "waiting",
    );
    expect(
      factoryTaskState(
        thread({
          factory: factory({ phase: "ready-for-review" }),
          session: { status: "running" } as EnvironmentThreadShell["session"],
        }),
      ),
    ).toBe("working");
    expect(factoryTaskState(thread({ factory: factory({ phase: "under-review" }) }))).toBe("idle");
    expect(factoryTaskState(thread({ factory: factory({ phase: "ready-to-merge" }) }))).toBe(
      "waiting",
    );
    expect(factoryTaskState(thread({ factory: factory({ phase: "merged" }) }))).toBe("done");
    expect(
      factoryTaskState(
        thread({
          factory: factory({ phase: "done" }),
          pullRequests: [
            {
              host: "github.com",
              repository: "acme/web",
              number: 9,
              url: "https://github.com/acme/web/pull/9",
              source: "agent",
              linkedAt: NOW,
              snapshot: {
                state: "open",
              } as EnvironmentThreadShell["pullRequests"][number]["snapshot"],
              stack: null,
            },
          ],
        }),
      ),
    ).toBe("waiting");
  });
});

describe("collectFactoryTasks", () => {
  it("lists only unarchived factory threads, waiting first then newest", () => {
    const tasks = collectFactoryTasks([
      thread({ id: ThreadId.make("plain"), factory: null }),
      thread({ id: ThreadId.make("archived"), archivedAt: NOW }),
      thread({
        id: ThreadId.make("old"),
        factory: factory({ startedAt: "2026-10-13T10:00:00.000Z" }),
      }),
      thread({ id: ThreadId.make("new") }),
      thread({ id: ThreadId.make("gate"), hasPendingApprovals: true }),
    ]);
    expect(tasks.map((task) => task.thread.id)).toEqual(["gate", "new", "old"]);
  });

  it("takes the open pull request link", () => {
    const [task] = collectFactoryTasks([
      thread({
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/web",
            number: 7,
            url: "https://github.com/acme/web/pull/7",
            source: "created",
            linkedAt: NOW,
            snapshot: null,
            stack: null,
          },
        ],
      }),
    ]);
    expect(task?.pullRequest?.url).toBe("https://github.com/acme/web/pull/7");
  });

  it("counts the tasks that wait on the human", () => {
    expect(
      countFactoryTasksWaiting([
        thread({ id: ThreadId.make("a"), hasPendingUserInput: true }),
        thread({ id: ThreadId.make("b") }),
        thread({ id: ThreadId.make("c"), hasPendingApprovals: true, archivedAt: NOW }),
      ]),
    ).toBe(1);
  });
});

describe("orderFactoryTasks", () => {
  it("applies the dragged order and keeps the rest behind it", () => {
    const tasks = collectFactoryTasks([
      thread({ id: ThreadId.make("a") }),
      thread({ id: ThreadId.make("b") }),
      thread({ id: ThreadId.make("c") }),
    ]);
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
          },
        }),
      ),
    ).toBe("dlc-link/omnibus");
    // The server stores the display name as owner/repo; the slug must not repeat the owner.
    expect(
      projectRepositorySlug(
        project({
          repositoryIdentity: {
            canonicalKey: "github.com/dlc-link/decentralization-manager",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/DLC-link/decentralization-manager.git",
            },
            owner: "dlc-link",
            displayName: "dlc-link/decentralization-manager",
          },
        }),
      ),
    ).toBe("dlc-link/decentralization-manager");
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
      },
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
});

describe("buildReviewRequestMessage", () => {
  it("asks for a first review or a re-review", () => {
    expect(buildReviewRequestMessage(["https://x/pull/1"])).toBe(
      "Please, review following PRs:\n- https://x/pull/1",
    );
    expect(buildReviewRequestMessage(["https://x/pull/1"], { reReview: true })).toBe(
      "Fixed following PRs, please, review again:\n- https://x/pull/1",
    );
    const fresh = collectFactoryTasks([
      thread({ factory: factory({ phase: "ready-for-review" }) }),
    ]);
    const again = collectFactoryTasks([
      thread({ factory: factory({ phase: "ready-for-review", reviewRound: 1 }) }),
    ]);
    expect(isReReviewRequest(fresh)).toBe(false);
    expect(isReReviewRequest(again)).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats minutes, hours, and days", () => {
    const start = Date.parse(NOW);
    expect(formatElapsed(NOW, start + 5 * 60_000)).toBe("5m");
    expect(formatElapsed(NOW, start + 3 * 3_600_000 + 60_000)).toBe("3h 1m");
    expect(formatElapsed(NOW, start + 72 * 3_600_000)).toBe("3d");
  });
});

describe("factoryJoinState", () => {
  const linked = (snapshot: { state: string; title?: string } | null) =>
    thread({
      factory: null,
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/web",
          number: 9,
          url: "https://github.com/acme/web/pull/9",
          source: "agent",
          linkedAt: NOW,
          snapshot: snapshot as EnvironmentThreadShell["pullRequests"][number]["snapshot"],
          stack: null,
        },
      ],
    });

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
    const joined = factoryJoinState(thread({ factory: null, title: "Fix the cap" }), NOW);
    expect(joined.askAgent).toBe(true);
    expect(joined.factory.input).toEqual({ kind: "free-text", value: "Fix the cap" });
  });
});
