import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type PullRequestActivity,
  type PullRequestDetail,
  type ServerSettings as ContractServerSettings,
  type ThreadFactory,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FactoryReviewReactor from "./FactoryReviewReactor.ts";
import * as ForkThreadStateStore from "./ForkThreadStateStore.ts";

const NOW = "2026-10-14T12:00:00.000Z";
const EARLIER = "2026-10-14T11:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const link = (overrides: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {}) =>
  ({
    host: "github.com",
    repository: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    source: "created",
    linkedAt: EARLIER,
    snapshot: {
      state: "open",
      title: "Add a cap",
      headBranch: "feature/cap",
      baseBranch: "main",
      isDraft: false,
      updatedAt: EARLIER,
      syncedAt: EARLIER,
      reviewDecision: "review-required",
      checksState: "pending",
      mergeability: "mergeable",
      ...overrides,
    },
    stack: null,
  }) satisfies ThreadPullRequestLink;

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Task",
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [link()],
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(EARLIER),
    updatedAt: DateTime.makeUnsafe(EARLIER),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function factory(overrides: Partial<ThreadFactory> = {}): ThreadFactory {
  return {
    input: { kind: "free-text", value: "Add a cap" },
    phase: "under-review",
    summary: null,
    startedAt: EARLIER,
    updatedAt: EARLIER,
    review: {
      seenUpdatedAt: EARLIER,
      seenUnresolved: 0,
      seenChecksState: "pending",
      seenMergeState: "clean",
      seenReviewId: null,
      seenCommentId: null,
    },
    ...overrides,
  };
}

const detail = (overrides: Partial<PullRequestDetail> = {}) =>
  ({
    provider: "github",
    capabilities: {} as never,
    viewerPermissions: {} as never,
    projectId: PROJECT_ID,
    projectTitle: "web",
    workspaceRoot: "/repos/web",
    repository: "acme/web",
    number: 7,
    title: "Add a cap",
    body: "",
    url: "https://github.com/acme/web/pull/7",
    author: { login: "author", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "feature/cap",
    baseBranch: "main",
    createdAt: EARLIER,
    updatedAt: EARLIER,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    ...overrides,
  }) as PullRequestDetail;

const activity = (overrides: Partial<PullRequestActivity> = {}): PullRequestActivity => ({
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  ...overrides,
});

interface HarnessOptions {
  readonly shell: OrchestrationV2ThreadShell;
  readonly factory: ThreadFactory;
  readonly settings?: ContractServerSettings;
  readonly detail?: PullRequestDetail;
  readonly activity?: PullRequestActivity;
  readonly contextUsage?: { readonly usedTokens: number; readonly maxTokens: number };
}

const makeHarness = Effect.fn("makeFactoryReviewHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const sent = yield* Ref.make<ReadonlyArray<string>>([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    updateSettings: () => Effect.die("unexpected settings write"),
    updateProviderInstance: () => Effect.die("unexpected provider mutation"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const storeLayer = ForkThreadStateStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const dependencies = Layer.mergeAll(
    storeLayer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === options.shell.id ? options.shell : null),
      getThreadRecords: () =>
        Effect.succeed({
          thread: {} as never,
          providerThreads:
            options.contextUsage === undefined
              ? []
              : [{ id: "provider-thread-1", contextUsage: options.contextUsage } as never],
        } as never),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (input) =>
        Ref.update(sent, (texts) => [...texts, input.text]).pipe(Effect.as({} as never)),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      detail: () => Effect.succeed(options.detail ?? detail()),
      activity: () => Effect.succeed(options.activity ?? activity()),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  return {
    activation,
    commands,
    sent,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    layer: FactoryReviewReactor.layer.pipe(Layer.provideMerge(dependencies)),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Starts the reactor against a stored task and waits for the first sweep. */
const startHarness = Effect.fn("startFactoryReviewHarness")(function* (
  harness: Harness,
  task: ThreadFactory,
) {
  const store = yield* ForkThreadStateStore.ForkThreadStateStore;
  const reactor = yield* FactoryReviewReactor.FactoryReviewReactor;
  yield* store.setFactory(THREAD_ID, task);
  // Every row change the test waits on lands here after the reactor saw it.
  const changes = yield* Queue.unbounded<ThreadFactory | null>();
  yield* store.subscribe.pipe(
    Stream.filter((event) => event.type === "updated"),
    Stream.runForEach((event) =>
      event.type === "updated" ? Queue.offer(changes, event.state.factory) : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* reactor.start();
  yield* Deferred.succeed(harness.activation, undefined);
  yield* reactor.drain;
  return { store, reactor, changes };
});

const eventBase = {
  id: EventId.make("event-1"),
  sequence: 1,
  threadId: THREAD_ID,
  occurredAt: DateTime.makeUnsafe(NOW),
} as const;

describe("FactoryReviewReactor", () => {
  it.effect("sends review work to the agent and moves the task to fix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [link({ checksState: "failing" })] }),
          factory: factory(),
        });
        yield* Effect.gen(function* () {
          const { store } = yield* startHarness(harness, factory());
          const sent = yield* Ref.get(harness.sent);
          assert.strictEqual(sent.length, 1);
          assert.match(sent[0]!, /^CI is failing/);
          const states = yield* store.list;
          assert.strictEqual(states[0]?.factory?.phase, "fix");
          assert.strictEqual(states[0]?.factory?.review?.seenChecksState, "failing");
          // The context was small, so nothing compacted first.
          assert.deepStrictEqual(yield* Ref.get(harness.commands), []);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("compacts a nearly full context before new work and queues the work behind it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [link({ checksState: "failing" })] }),
          factory: factory(),
          contextUsage: { usedTokens: 170_000, maxTokens: 200_000 },
        });
        yield* Effect.gen(function* () {
          yield* startHarness(harness, factory());
          const commands = yield* Ref.get(harness.commands);
          assert.strictEqual(commands.length, 1);
          assert.strictEqual(commands[0]?.type, "message.dispatch");
          if (commands[0]?.type === "message.dispatch") {
            assert.strictEqual(commands[0].text, "/compact");
          }
          assert.strictEqual((yield* Ref.get(harness.sent)).length, 1);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect.each([false, true])("only ignores CI when enabled in settings (%s)", (allowed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [link({ checksState: "failing" })] }),
          factory: factory(),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            factoryIgnoreCiEnabled: allowed,
            factoryIgnoreCi: true,
          },
        });
        yield* Effect.gen(function* () {
          const { store } = yield* startHarness(harness, factory());
          const sent = yield* Ref.get(harness.sent);
          assert.strictEqual(sent.length, allowed ? 0 : 1);
          const states = yield* store.list;
          assert.strictEqual(states[0]?.factory?.phase, allowed ? "under-review" : "fix");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("holds the work under token saving instead of messaging the agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [link({ checksState: "failing" })] }),
          factory: factory(),
          settings: { ...DEFAULT_SERVER_SETTINGS, factoryTokenSaving: true },
        });
        yield* Effect.gen(function* () {
          const { store } = yield* startHarness(harness, factory());
          assert.deepStrictEqual(yield* Ref.get(harness.sent), []);
          const states = yield* store.list;
          assert.strictEqual(states[0]?.factory?.phase, "under-review");
          assert.match(states[0]?.factory?.pendingWork?.message ?? "", /^CI is failing/);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("reads reviews from the host and moves an approved green task to ready to merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({
            pullRequests: [link({ reviewDecision: "approved", checksState: "passing" })],
          }),
          factory: factory(),
          activity: activity({
            comments: [
              {
                id: "PRR_1",
                kind: "review",
                author: { login: "reviewer", name: null, avatarUrl: null },
                body: "LGTM",
                createdAt: NOW,
                url: null,
                path: null,
                reviewState: "APPROVED",
              },
            ],
          }),
        });
        yield* Effect.gen(function* () {
          const { store } = yield* startHarness(harness, factory());
          const states = yield* store.list;
          assert.strictEqual(states[0]?.factory?.phase, "ready-to-merge");
          assert.strictEqual(states[0]?.factory?.review?.seenReviewId, "PRR_1");
          assert.deepStrictEqual(yield* Ref.get(harness.sent), []);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("records the phase marker of a finished assistant message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [] }),
          factory: factory({ phase: "implementation" }),
        });
        yield* Effect.gen(function* () {
          const { changes } = yield* startHarness(harness, factory({ phase: "implementation" }));
          yield* harness.publishEvent({
            ...eventBase,
            type: "turn-item.updated",
            payload: {
              id: TurnItemId.make("item-1"),
              threadId: THREAD_ID,
              runId: RunId.make("run-1"),
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              createdAt: DateTime.makeUnsafe(NOW),
              updatedAt: DateTime.makeUnsafe(NOW),
              type: "assistant_message",
              messageId: "message-1" as never,
              text: "Done with the code.\n\nFACTORY PHASE: human-gate Which cap value do you want?",
              streaming: false,
            } as never,
          });
          const next = yield* Queue.take(changes);
          assert.strictEqual(next?.phase, "human-gate");
          assert.strictEqual(next?.summary, "Which cap value do you want?");
          assert.strictEqual(next?.gatedFrom, "implementation");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("ends the wait on a blocking pull request when the thread wakes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blocked = factory({
          phase: "implementation",
          blockedBy: {
            url: "https://github.com/acme/web/pull/3",
            host: "github.com",
            repository: "acme/web",
            number: 3,
          },
        });
        const harness = yield* makeHarness({
          shell: shell({ pullRequests: [] }),
          factory: blocked,
        });
        yield* Effect.gen(function* () {
          const { changes } = yield* startHarness(harness, blocked);
          yield* harness.publishEvent({
            ...eventBase,
            type: "thread.unsnoozed",
            payload: { threadId: THREAD_ID } as never,
          } as never);
          const next = yield* Queue.take(changes);
          assert.strictEqual(next?.blockedBy, null);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
