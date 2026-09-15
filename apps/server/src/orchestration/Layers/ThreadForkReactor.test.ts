// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderWorkspaceStateService from "../../provider/ProviderWorkspaceStateService.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import { ThreadForkReactorLive } from "./ThreadForkReactor.ts";
import * as RuntimeReceiptBus from "../Services/RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadForkReactor } from "../Services/ThreadForkReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const sourceThreadId = ThreadId.make("thread-source");
const forkThreadId = ThreadId.make("thread-fork");
const turnId = TurnId.make("turn-1");

const tempDirs: string[] = [];

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // The fixture repository ignores the developer's git configuration, so a
    // signing key or a hook on this machine cannot change the test's result.
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createGitRepository(): string {
  const cwd = makeTempDir("t3-thread-fork-");
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

interface ForkBindingCall {
  readonly sourceThreadId: ThreadId;
  readonly forkThreadId: ThreadId;
  readonly turnId: TurnId;
  readonly turnCount: number;
}

/**
 * Builds the reactor over a real git repository. The fork's worktree is real
 * too, so the checkpoint restore into it runs for real; only GitManager's
 * wider machinery and the provider are stubbed.
 */
function makeHarness(options?: { readonly forkBindingFails?: boolean }) {
  const cwd = createGitRepository();
  const worktreeRoot = makeTempDir("t3-fork-worktree-");

  const forkBindings: Array<ForkBindingCall> = [];
  const linkedWorktrees: Array<string> = [];
  const setupRuns: Array<string> = [];
  const createdWorktrees: Array<{ readonly refName: string; readonly path: string }> = [];

  const providerLayer = Layer.succeed(ProviderService, {
    prepareForkBinding: (input: ForkBindingCall) =>
      options?.forkBindingFails === true
        ? Effect.fail(
            new ProviderValidationError({
              operation: "ProviderService.prepareForkBinding",
              issue: "Provider 'opencode' does not support forking a thread.",
            }),
          )
        : Effect.sync(() => void forkBindings.push(input)),
  } as unknown as ProviderService["Service"]);

  const gitWorkflowLayer = Layer.succeed(GitWorkflowService.GitWorkflowService, {
    createWorktree: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly newRefName?: string;
    }) =>
      Effect.sync(() => {
        const refName = input.newRefName ?? input.refName;
        const path = NodePath.join(worktreeRoot, refName.replace(/\//g, "-"));
        runGit(input.cwd, ["worktree", "add", "-b", refName, path, input.refName]);
        createdWorktrees.push({ refName, path });
        return { worktree: { path, refName } };
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"]);

  const workspaceStateLayer = Layer.succeed(
    ProviderWorkspaceStateService.ProviderWorkspaceStateService,
    {
      linkForWorktree: (input: { readonly worktreePath: string }) =>
        Effect.sync(() => void linkedWorktrees.push(input.worktreePath)),
    } as unknown as ProviderWorkspaceStateService.ProviderWorkspaceStateService["Service"],
  );

  const setupRunnerLayer = Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
    runForThread: (input: { readonly worktreePath: string }) =>
      Effect.sync(() => {
        setupRuns.push(input.worktreePath);
        return { status: "skipped" as const };
      }),
  } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]);

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );

  const layer = ThreadForkReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(gitWorkflowLayer),
    Layer.provideMerge(workspaceStateLayer),
    Layer.provideMerge(setupRunnerLayer),
    Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-reactor-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  return { cwd, layer, forkBindings, linkedWorktrees, setupRuns, createdWorktrees };
}

/** Seeds a source thread whose turn 1 checkpoint holds README at "v2". */
const seedSourceThread = (cwd: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId,
      title: "Test Project",
      workspaceRoot: cwd,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5",
      },
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: sourceThreadId,
      projectId,
      title: "Source thread",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: "main",
      worktreePath: cwd,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make("cmd-history"),
      threadId: sourceThreadId,
      messages: [
        {
          messageId: MessageId.make("message-user"),
          role: "user",
          text: "Please edit the README",
          createdAt,
        },
      ],
    });

    NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
    yield* checkpointStore.captureCheckpoint({
      cwd,
      checkpointRef: checkpointRefForThreadTurn(sourceThreadId, 1),
    });
    NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");

    yield* engine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: CommandId.make("cmd-turn-diff"),
      threadId: sourceThreadId,
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make(checkpointRefForThreadTurn(sourceThreadId, 1)),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-assistant"),
      completedAt: "2026-01-01T00:01:00.000Z",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make("cmd-activity"),
      threadId: sourceThreadId,
      activity: {
        id: EventId.make("event-activity-1"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Edited README.md",
        payload: { path: "README.md" },
        turnId,
        createdAt,
      },
      createdAt,
    });

    return engine;
  });

const forkCommand = {
  type: "thread.fork" as const,
  commandId: CommandId.make("cmd-fork"),
  threadId: sourceThreadId,
  forkThreadId,
  turnCount: 1,
  title: "Source thread (fork)",
  createdAt,
};

describe("ThreadForkReactor", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it.effect("forks a thread into its own worktree at the checkpointed turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadForkReactor;
      const receiptBus = yield* RuntimeReceiptBus.RuntimeReceiptBus;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* reactor.start();
      const receiptFiber = yield* Stream.runHead(receiptBus.streamEventsForTest).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      const engine = yield* seedSourceThread(harness.cwd);
      yield* engine.dispatch(forkCommand);
      yield* reactor.drain;

      expect(Option.getOrUndefined(yield* Fiber.join(receiptFiber))).toMatchObject({
        type: "thread.forked",
        threadId: sourceThreadId,
        forkThreadId,
        checkpointTurnCount: 1,
      });

      const worktree = harness.createdWorktrees[0];
      expect(worktree?.refName).toMatch(/^t3code\/[0-9a-f]{8}$/);
      // The fork holds the checkpointed files, not the source thread's later state.
      expect(NodeFS.readFileSync(NodePath.join(worktree!.path, "README.md"), "utf8")).toBe("v2\n");
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");

      expect(harness.forkBindings).toEqual([
        { sourceThreadId, forkThreadId, turnId, turnCount: 1 },
      ]);
      expect(harness.linkedWorktrees).toEqual([worktree!.path]);
      expect(harness.setupRuns).toEqual([worktree!.path]);

      const readModel = yield* snapshotQuery.getSnapshot();
      const fork = readModel.threads.find((thread) => thread.id === forkThreadId);
      expect(fork).toMatchObject({
        worktreePath: worktree!.path,
        branch: worktree!.refName,
        title: "Source thread (fork)",
      });
      expect(fork?.messages.map((message) => message.text)).toEqual(["Please edit the README"]);
      expect(fork?.activities.map((activity) => activity.summary)).toEqual(["Edited README.md"]);
      // A copied activity is a new row, so it never reuses the source event id.
      expect(fork?.activities[0]?.id).not.toBe("event-activity-1");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reports a provider that cannot fork on the source thread", () => {
    const harness = makeHarness({ forkBindingFails: true });
    return Effect.gen(function* () {
      const reactor = yield* ThreadForkReactor;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* reactor.start();

      const engine = yield* seedSourceThread(harness.cwd);
      yield* engine.dispatch(forkCommand);
      yield* reactor.drain;

      const readModel = yield* snapshotQuery.getSnapshot();
      expect(readModel.threads.find((thread) => thread.id === forkThreadId)).toBeUndefined();
      // A fork the provider refuses leaves no worktree behind.
      expect(harness.createdWorktrees).toEqual([]);
      const source = readModel.threads.find((thread) => thread.id === sourceThreadId);
      expect(
        source?.activities.find((activity) => activity.kind === "thread.fork.failed"),
      ).toMatchObject({
        tone: "error",
        payload: { detail: expect.stringContaining("does not support forking") },
      });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
