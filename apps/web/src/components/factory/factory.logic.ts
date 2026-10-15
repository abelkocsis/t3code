import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  FactoryInput,
  SlackThreadRef,
  ThreadFactory,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import {
  FACTORY_COMPLETED_PHASES,
  FACTORY_PHASE_LABELS,
  factoryInputRepository,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

/**
 * What the row says about the task right now. Waiting on the human comes first. A task that
 * is not waiting, failed, or done is working: an idle session between watcher ticks still
 * counts as the factory being busy.
 */
export type FactoryTaskState = "waiting" | "working" | "idle" | "snoozed" | "error" | "done";

export const FACTORY_TASK_STATE_LABELS: Record<FactoryTaskState, string> = {
  waiting: "Waiting on you",
  working: "Working",
  idle: "Idle",
  snoozed: "Snoozed",
  error: "Error",
  done: "Done",
};

/** A snoozed task is parked on purpose, so it never counts as waiting on the human. */
export function isFactoryTaskSnoozed(thread: EnvironmentThreadShell, now: number): boolean {
  if (thread.snoozedUntil == null) return false;
  const wakeAt = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(wakeAt) && wakeAt > now;
}

export interface FactoryTask {
  readonly thread: EnvironmentThreadShell;
  readonly factory: ThreadFactory;
  readonly state: FactoryTaskState;
  readonly pullRequest:
    | (ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot | null })
    | null;
}

/** The pull request a task follows: an open one first, then the newest linked one. */
export function factoryTaskPullRequest(thread: EnvironmentThreadShell): FactoryTask["pullRequest"] {
  const links = visibleThreadPullRequests(thread.pullRequests);
  return links.find((link) => link.snapshot?.state === "open") ?? links.at(-1) ?? null;
}

/**
 * Ready for review and ready to merge wait on the human while the agent is quiet: one sends
 * the review request, the other presses Merge. Under review, a quiet agent is idle: the server watches the pull
 * request and wakes it when there is work. Everywhere else a quiet agent still counts as
 * working, because the flow is in its hands.
 */
export function factoryTaskState(
  thread: EnvironmentThreadShell,
  now: number = Date.now(),
): FactoryTaskState {
  if (isFactoryTaskSnoozed(thread, now)) return "snoozed";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  // A running agent is working at every stage, also when the user messaged it at a gate.
  const session = thread.session;
  if (session?.status === "running" || session?.status === "starting") return "working";
  const phase = thread.factory?.phase;
  // "done" with an open pull request is the moment before the server moves the task to
  // ready for review, so it already waits on the human rather than looking finished.
  const pullRequest = factoryTaskPullRequest(thread);
  if (phase === "done" && pullRequest?.snapshot?.state === "open") return "waiting";
  if (phase && FACTORY_COMPLETED_PHASES.includes(phase)) return "done";
  if (phase === "ready-for-review" || phase === "ready-to-merge") return "waiting";
  if (thread.latestTurn?.state === "error" || session?.status === "error") return "error";
  return phase === "under-review" ? "idle" : "working";
}

/** The stages of the progress bar under each task. */
export const FACTORY_PROGRESS_STAGES = [
  "Spec",
  "Build",
  "Agent review",
  "Pull request ready",
  "Human review",
  "Merge",
] as const;

function progressStage(
  phase: ThreadFactory["phase"],
  factory: ThreadFactory,
  hasPullRequest: boolean,
): number | null {
  switch (phase) {
    case "requirements":
    case "product-spec":
    case "implementation-spec":
      return 0;
    case "implementation":
      return 1;
    case "review":
    case "converged":
      return 2;
    case "fix":
      // A fix belongs to the review it answers.
      if ((factory.reviewRound ?? 0) > 0) return 4;
      return hasPullRequest ? 3 : 2;
    case "done":
    case "ready-for-review":
      return 3;
    case "under-review":
      return 4;
    case "ready-to-merge":
    case "merged":
      return 5;
    case "human-gate":
      return factory.gatedFrom && factory.gatedFrom !== "human-gate"
        ? progressStage(factory.gatedFrom, factory, hasPullRequest)
        : null;
  }
}

/**
 * Where a task stands on the progress bar. A human gate keeps the stage it interrupted; a gate
 * recorded before the stage was stored has no position.
 */
export function factoryProgress(task: Pick<FactoryTask, "factory" | "pullRequest">): {
  readonly stage: number | null;
  readonly gated: boolean;
  readonly complete: boolean;
} {
  const { factory } = task;
  return {
    stage: progressStage(factory.phase, factory, task.pullRequest !== null),
    gated: factory.phase === "human-gate",
    complete: factory.phase === "merged",
  };
}

/**
 * What the overlay says about a factory task that asks for attention. A task waiting on the
 * human says so; otherwise the stage name is more useful than "Finished".
 */
export function factoryAttentionLabel(thread: EnvironmentThreadShell): {
  readonly label: string;
  readonly waiting: boolean;
} | null {
  const factory = thread.factory;
  if (!factory) return null;
  const state = factoryTaskState(thread);
  if (state === "waiting") return { label: FACTORY_TASK_STATE_LABELS.waiting, waiting: true };
  if (state === "error") return { label: FACTORY_TASK_STATE_LABELS.error, waiting: false };
  return { label: FACTORY_PHASE_LABELS[factory.phase], waiting: false };
}

/**
 * The factory state for an existing thread added by hand. A linked pull request decides the
 * stage: open, or not synced yet, is ready for review. Without one the agent works out the
 * phase, so `askAgent` is true and "requirements" holds the place until its marker line lands.
 */
export function factoryJoinState(
  thread: EnvironmentThreadShell,
  now: string,
): { readonly factory: ThreadFactory; readonly askAgent: boolean } {
  const pullRequest = factoryTaskPullRequest(thread);
  if (pullRequest) {
    const state = pullRequest.snapshot?.state;
    return {
      factory: {
        input: { kind: "pull-request", value: pullRequest.url },
        phase: state === "merged" ? "merged" : state === "closed" ? "done" : "ready-for-review",
        summary: pullRequest.snapshot?.title ?? null,
        startedAt: now,
        updatedAt: now,
      },
      askAgent: false,
    };
  }
  return {
    factory: {
      input: { kind: "free-text", value: thread.title },
      phase: "requirements",
      summary: "Working out which phase this task is in.",
      startedAt: now,
      updatedAt: now,
    },
    askAgent: true,
  };
}

/**
 * Every unarchived factory thread, the ones that wait on a human first, then newest first.
 * Done tasks sort last; the page lists them in their own section.
 */
export function collectFactoryTasks(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<FactoryTask> {
  const tasks: FactoryTask[] = [];
  for (const thread of threads) {
    if (!thread.factory || thread.archivedAt !== null) continue;
    tasks.push({
      thread,
      factory: thread.factory,
      state: factoryTaskState(thread),
      pullRequest: factoryTaskPullRequest(thread),
    });
  }
  const rank: Record<FactoryTaskState, number> = {
    waiting: 0,
    error: 1,
    working: 2,
    idle: 3,
    snoozed: 4,
    done: 5,
  };
  return tasks.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] || b.factory.startedAt.localeCompare(a.factory.startedAt),
  );
}

export function factoryTaskKey(task: FactoryTask): string {
  return `${task.thread.environmentId}:${task.thread.id}`;
}

/** Puts the tasks the user dragged into place first, in that order; the rest keep their sort. */
export function orderFactoryTasks(
  tasks: ReadonlyArray<FactoryTask>,
  order: ReadonlyArray<string>,
): ReadonlyArray<FactoryTask> {
  const position = new Map(order.map((key, index) => [key, index] as const));
  return tasks
    .map((task, index) => ({ task, index, position: position.get(factoryTaskKey(task)) }))
    .sort((a, b) => {
      if (a.position !== undefined && b.position !== undefined) return a.position - b.position;
      if (a.position !== undefined) return -1;
      if (b.position !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

/** The order after dragging one task onto another's slot, written over the whole list. */
export function moveFactoryTask(
  tasks: ReadonlyArray<FactoryTask>,
  fromKey: string,
  toKey: string,
): ReadonlyArray<string> {
  const keys = tasks.map(factoryTaskKey);
  const from = keys.indexOf(fromKey);
  const to = keys.indexOf(toKey);
  if (from === -1 || to === -1 || from === to) return keys;
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function countFactoryTasksWaiting(threads: ReadonlyArray<EnvironmentThreadShell>): number {
  return threads.filter(
    (thread) =>
      thread.factory !== null &&
      thread.factory !== undefined &&
      thread.archivedAt === null &&
      factoryTaskState(thread) === "waiting",
  ).length;
}

/** The `owner/repo` a project's git remote points at, or null when the remote is not GitHub-like. */
export function projectRepositorySlug(project: EnvironmentProject): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  // The canonical key is `host/owner/repo`, already lower-cased and without `.git`.
  const canonical = identity.canonicalKey.split("/").slice(1).join("/");
  if (canonical.split("/").length === 2) return canonical.toLowerCase();
  const url = identity.locator.remoteUrl;
  const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/**
 * Picks the project a task belongs to. A GitHub issue maps by repository. Other inputs map when
 * exactly one project's repository name or title appears in the text. Anything else asks.
 */
export function resolveFactoryProject(
  input: FactoryInput,
  projects: ReadonlyArray<EnvironmentProject>,
):
  | { kind: "resolved"; project: EnvironmentProject }
  | { kind: "ask"; candidates: ReadonlyArray<EnvironmentProject> } {
  const repository = factoryInputRepository(input);
  if (repository) {
    const matches = projects.filter((project) => projectRepositorySlug(project) === repository);
    if (matches.length === 1) return { kind: "resolved", project: matches[0]! };
    return { kind: "ask", candidates: matches.length > 0 ? matches : projects };
  }
  const text = input.value.toLowerCase();
  const matches = projects.filter((project) => {
    const slug = projectRepositorySlug(project);
    const repoName = slug?.split("/")[1];
    const title = project.title.toLowerCase();
    return (
      (slug !== null && text.includes(slug)) ||
      (repoName !== undefined && repoName.length >= 3 && text.includes(repoName)) ||
      (title.length >= 3 && text.includes(title))
    );
  });
  if (matches.length === 1) return { kind: "resolved", project: matches[0]! };
  return { kind: "ask", candidates: matches.length > 0 ? matches : projects };
}

export function formatElapsed(fromIso: string, now: number): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function slackThreadPostedAt(slackThread: SlackThreadRef): Date {
  return new Date(Number(slackThread.threadTs.split(".")[0]) * 1000);
}

/** The Slack text. A second round says the fixes are in, so reviewers know to look again. */
export function buildReviewRequestMessage(
  urls: ReadonlyArray<string>,
  options: { readonly reReview?: boolean } = {},
): string {
  const lead = options.reReview
    ? "Fixed following PRs, please, review again:"
    : "Please, review following PRs:";
  return [lead, ...urls.map((url) => `- ${url}`)].join("\n");
}

/** True when every task has been through review before, so the request is a re-review. */
export function isReReviewRequest(tasks: ReadonlyArray<FactoryTask>): boolean {
  return tasks.length > 0 && tasks.every((task) => (task.factory.reviewRound ?? 0) > 0);
}
