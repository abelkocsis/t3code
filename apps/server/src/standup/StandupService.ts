/**
 * Assembles and generates the daily summary.
 *
 * The server does all the collecting, so the model call is one shot with no
 * tools: every provider adapter supports it, a generation takes seconds, and
 * each collector is testable on its own. The model only ever sees the evidence
 * assembled here, which is also why it cannot invent a repository or a number.
 *
 * Collection failures never fail a generation. A repository that has gone
 * missing, a pull request host that is signed out, or an unreadable transcript
 * directory each cost the summary one source; failing the whole summary over
 * one of them would cost the user the feature on the morning they need it.
 *
 * @module StandupService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  StandupDay,
  StandupError,
  type StandupGenerateInput,
  type StandupItem,
  type StandupSaveInput,
  type StandupState,
  type StandupStateInput,
  type StandupSummary,
  type StandupUpdateItemsInput,
} from "@t3tools/contracts";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { listTranscriptFiles } from "../usage/usageTranscriptReader.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";

import {
  groupPromptsByWorkspace,
  isReportableWorkspace,
  parseCliPromptLine,
  type CliPrompt,
} from "./standupCliTranscripts.ts";
import {
  isStandupDay,
  parseIsoUtc,
  standupDayWindow,
  toIsoUtc,
  toStandupDay,
} from "./standupDays.ts";
import {
  buildCommitLogArgs,
  FACT_LIMITS,
  findUnsupportedClaims,
  hasStandupWork,
  renderStandupFacts,
  type StandupCommitFact,
  type StandupFacts,
  type StandupPullRequestFact,
} from "./standupFacts.ts";
import { StandupStore } from "./StandupStore.ts";
import { readLatestWorkInstantMs, readProjectRoots, readThreadFacts } from "./StandupWorkQuery.ts";

/** A worktree read that has not answered by now is a repository we skip. */
const GIT_TIMEOUT_MS = 10_000;

/** Rows per host. The window filter then keeps only the day's own. */
const PULL_REQUEST_FETCH_LIMIT = 100;

export class StandupService extends Context.Service<
  StandupService,
  {
    readonly getState: (input: StandupStateInput) => Effect.Effect<StandupState, StandupError>;
    readonly generate: (input: StandupGenerateInput) => Effect.Effect<StandupSummary, StandupError>;
    readonly updateItems: (
      input: StandupUpdateItemsInput,
    ) => Effect.Effect<StandupSummary, StandupError>;
    readonly save: (input: StandupSaveInput) => Effect.Effect<StandupSummary, StandupError>;
  }
>()("t3/standup/StandupService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const pullRequests = yield* PullRequestService;
  const settingsService = yield* ServerSettingsService;
  const store = yield* StandupStore;
  const textGeneration = yield* TextGeneration;

  const assertDay = (day: string) =>
    isStandupDay(day)
      ? Effect.void
      : Effect.fail(
          new StandupError({ reason: "invalidDay", detail: `Not a YYYY-MM-DD day: ${day}` }),
        );

  // -------------------------------------------------------------------------
  // Collectors
  // -------------------------------------------------------------------------

  /** The git identity a worktree commits under. Empty when git has none configured. */
  const readGitIdentity = (cwd: string) =>
    Effect.forEach(["user.email", "user.name"], (key) =>
      git
        .execute({
          operation: "StandupService.readGitIdentity",
          cwd,
          args: ["config", "--get", key],
          timeoutMs: GIT_TIMEOUT_MS,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.catchCause(() => Effect.succeed("")),
        ),
    ).pipe(Effect.map((values) => values.filter((value) => value.length > 0)));

  /**
   * Commits the user authored in each project worktree during the window.
   *
   * `--all` also walks fetched remote branches, so a worktree holds the whole
   * team's commits. Without an author filter, a colleague's day was reported as
   * the user's. The filter matches the worktree's own git identity by email and
   * by name, so a second identity that keeps the same name still counts.
   */
  const collectCommits = Effect.fn("StandupService.collectCommits")(function* (window: {
    readonly startMs: number;
    readonly endMs: number;
  }) {
    const projects = yield* readProjectRoots(sql).pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<never>)),
    );
    const perProject = yield* Effect.forEach(
      projects,
      (project) =>
        readGitIdentity(project.workspace_root).pipe(
          Effect.flatMap((identity) =>
            git.execute({
              operation: "StandupService.collectCommits",
              cwd: project.workspace_root,
              args: buildCommitLogArgs({
                identity,
                sinceIso: toIsoUtc(window.startMs),
                untilIso: toIsoUtc(window.endMs),
              }),
              timeoutMs: GIT_TIMEOUT_MS,
            }),
          ),
          Effect.map((result) =>
            result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line): StandupCommitFact => {
                // An abbreviated sha holds no space, so the first one splits the line.
                const separator = line.indexOf(" ");
                return separator === -1
                  ? { projectTitle: project.title, sha: line, subject: "" }
                  : {
                      projectTitle: project.title,
                      sha: line.slice(0, separator),
                      subject: line.slice(separator + 1),
                    };
              }),
          ),
          // A project whose directory has moved must not fail the summary.
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<StandupCommitFact>)),
        ),
      { concurrency: 4 },
    );
    const seen = new Set<string>();
    return perProject.flat().filter((commit) => {
      if (seen.has(commit.sha)) return false;
      seen.add(commit.sha);
      return true;
    });
  });

  /** Pull requests the user authored that moved during the window. */
  const collectPullRequests = Effect.fn("StandupService.collectPullRequests")(function* (window: {
    readonly startMs: number;
    readonly endMs: number;
  }) {
    const listed = yield* pullRequests
      .list({ state: "all", involvement: "authored", limit: PULL_REQUEST_FETCH_LIMIT })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (listed === null) return [] as ReadonlyArray<StandupPullRequestFact>;
    return listed.entries
      .filter((entry) => {
        const updatedMs = parseIsoUtc(entry.updatedAt);
        return updatedMs !== null && updatedMs >= window.startMs && updatedMs < window.endMs;
      })
      .slice(0, FACT_LIMITS.pullRequests)
      .map((entry): StandupPullRequestFact => ({
        repository: entry.repository,
        number: entry.number,
        title: entry.title,
        state: entry.state,
        url: entry.url,
      }));
  });

  /**
   * Prompts from Claude CLI sessions that ran during the window.
   *
   * The transcript files are listed by modification time, which is a coarse
   * filter: a session touched after the window still holds the window's lines.
   * The per-line timestamp is what actually decides.
   */
  const collectCliSessions = Effect.fn("StandupService.collectCliSessions")(function* (window: {
    readonly startMs: number;
    readonly endMs: number;
  }) {
    const collected = yield* Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
      const nested = path.join(claudeHome, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const root = nestedExists ? nested : path.join(claudeHome, "projects");

      const files = yield* Effect.promise(() => listTranscriptFiles(root, window.startMs));
      const prompts = yield* Effect.forEach(
        files,
        (file) =>
          fileSystem.readFileString(file.path).pipe(
            Effect.map((contents) =>
              contents
                .split("\n")
                .map((line) => parseCliPromptLine(line))
                .filter((prompt): prompt is CliPrompt => prompt !== null)
                .filter(
                  (prompt) =>
                    prompt.timestampMs >= window.startMs &&
                    prompt.timestampMs < window.endMs &&
                    isReportableWorkspace({
                      cwd: prompt.cwd,
                      worktreesDir: config.worktreesDir,
                    }),
                ),
            ),
            Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CliPrompt>)),
          ),
        { concurrency: 8 },
      );
      return prompts.flat();
    }).pipe(
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CliPrompt>)),
    );

    return groupPromptsByWorkspace(collected, {
      workspaces: FACT_LIMITS.cliSessions,
      promptsPerWorkspace: FACT_LIMITS.promptsPerCliSession,
    });
  });

  const collectFacts = Effect.fn("StandupService.collectFacts")(function* (
    day: string,
    timeZone: string,
  ) {
    const window = standupDayWindow(day, timeZone);
    const [threads, commits, prs, cliSessions] = yield* Effect.all(
      [
        readThreadFacts(sql, window).pipe(Effect.catchCause(() => Effect.succeed([]))),
        collectCommits(window),
        collectPullRequests(window),
        collectCliSessions(window),
      ],
      { concurrency: 4 },
    );
    return {
      day,
      timeZone,
      threads,
      commits,
      pullRequests: prs,
      cliSessions,
    } satisfies StandupFacts;
  });

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Where the provider CLI runs for a generation.
   *
   * The prompt already carries every fact, so the directory only decides which
   * provider configuration the CLI picks up. A project worktree is the closest
   * match to how the user runs that provider; the state directory is a readable
   * fallback for an environment with no project yet.
   */
  const resolveGenerationCwd = readProjectRoots(sql).pipe(
    Effect.map((projects) => projects[0]?.workspace_root ?? config.stateDir),
    Effect.catchCause(() => Effect.succeed(config.stateDir)),
  );

  /**
   * The day the panel opens on: the last day before today that recorded work.
   *
   * Today is excluded because a standup reports a finished day. At nine in the
   * morning the current day holds one thread and says nothing useful, while the
   * day the meeting is about is already complete.
   *
   * An environment whose only work is today still gets that day, so a first run
   * shows something rather than an empty panel.
   */
  const resolveDefaultDay = (timeZone: string) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const startOfToday = standupDayWindow(toStandupDay(nowMs, timeZone), timeZone).startMs;
      const beforeToday = yield* readLatestWorkInstantMs(sql, startOfToday);
      if (beforeToday !== null) return toStandupDay(beforeToday, timeZone);
      const anyWork = yield* readLatestWorkInstantMs(sql, null);
      return anyWork === null ? null : toStandupDay(anyWork, timeZone);
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const getState: StandupService["Service"]["getState"] = Effect.fn("StandupService.getState")(
    function* (input) {
      if (input.day !== undefined) yield* assertDay(input.day);
      const defaultDay = yield* resolveDefaultDay(input.timeZone);
      const day = input.day ?? defaultDay;
      const stored = yield* store.readAll;

      if (day === null) {
        return {
          defaultDay: null,
          day: null,
          storedDays: stored.map((summary) => summary.day),
          summary: null,
          hasWork: false,
        };
      }

      const summary = stored.find((candidate) => candidate.day === day) ?? null;
      // A generated day always had work, so the collectors are only run when
      // the client is about to be offered a Generate button.
      const hasWork = summary !== null || hasStandupWork(yield* collectFacts(day, input.timeZone));

      return {
        defaultDay: defaultDay === null ? null : StandupDay.make(defaultDay),
        day: StandupDay.make(day),
        storedDays: stored.map((candidate) => candidate.day),
        summary,
        hasWork,
      };
    },
  );

  const generate: StandupService["Service"]["generate"] = Effect.fn("StandupService.generate")(
    function* (input) {
      yield* assertDay(input.day);
      const facts = yield* collectFacts(input.day, input.timeZone);
      if (!hasStandupWork(facts)) {
        return yield* new StandupError({
          reason: "noWork",
          detail: `No thread, commit or session was recorded on ${input.day}.`,
        });
      }

      const previous = yield* store.read(input.day);
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new StandupError({
              reason: "generateFailed",
              detail: "Server settings could not be read, so no model is selected.",
              cause,
            }),
        ),
      );

      const evidence = renderStandupFacts(facts);
      const cwd = yield* resolveGenerationCwd;
      const generated = yield* textGeneration
        .generateDailySummary({
          cwd,
          day: input.day,
          facts: evidence,
          keptItems: (previous?.items ?? [])
            .filter((item) => !item.excluded && item.source !== "manual")
            .map((item) => item.text),
          excludedItems: (previous?.items ?? [])
            .filter((item) => item.excluded)
            .map((item) => item.text),
          modelSelection: settings.textGenerationModelSelection,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StandupError({
                reason: "generateFailed",
                detail: "The model could not write the summary.",
                cause,
              }),
          ),
        );

      // A bullet that names a repository or a pull request the evidence never
      // mentioned is invented, whatever the prompt told the model.
      const knownNames = yield* readProjectRoots(sql).pipe(
        Effect.map((projects) => projects.map((project) => project.title)),
        Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)),
      );
      const supportedItems: Array<{ readonly text: string; readonly source: string }> = [];
      for (const item of generated.items) {
        const reasons = findUnsupportedClaims({ text: item.text, evidence, knownNames });
        if (reasons.length === 0) {
          supportedItems.push(item);
          continue;
        }
        yield* Effect.logWarning("dropped a standup item the evidence does not support", {
          day: input.day,
          text: item.text,
          reasons,
        });
      }

      // Items the user typed are theirs, so a regeneration keeps them verbatim.
      const manualItems = (previous?.items ?? []).filter((item) => item.source === "manual");
      const summary: StandupSummary = {
        day: StandupDay.make(input.day),
        timeZone: input.timeZone,
        items: [
          ...supportedItems.map((item, index): StandupItem => ({
            itemId: `${input.day}-${index}`,
            text: item.text,
            source: item.source as StandupItem["source"],
            excluded: false,
          })),
          ...manualItems,
        ],
        generatedAt: toIsoUtc(yield* Clock.currentTimeMillis),
        ...(previous?.savedText !== undefined ? { savedText: previous.savedText } : {}),
        ...(previous?.savedAt !== undefined ? { savedAt: previous.savedAt } : {}),
      };
      yield* store.write(summary);
      return summary;
    },
  );

  const updateItems: StandupService["Service"]["updateItems"] = Effect.fn(
    "StandupService.updateItems",
  )(function* (input) {
    yield* assertDay(input.day);
    const previous = yield* store.read(input.day);
    const summary: StandupSummary = {
      day: StandupDay.make(input.day),
      timeZone: input.timeZone,
      items: input.items,
      generatedAt: previous?.generatedAt ?? toIsoUtc(yield* Clock.currentTimeMillis),
      ...(previous?.savedText !== undefined ? { savedText: previous.savedText } : {}),
      ...(previous?.savedAt !== undefined ? { savedAt: previous.savedAt } : {}),
    };
    yield* store.write(summary);
    return summary;
  });

  const save: StandupService["Service"]["save"] = Effect.fn("StandupService.save")(
    function* (input) {
      yield* assertDay(input.day);
      const previous = yield* store.read(input.day);
      const summary: StandupSummary = {
        day: StandupDay.make(input.day),
        timeZone: input.timeZone,
        items: previous?.items ?? [],
        generatedAt: previous?.generatedAt ?? toIsoUtc(yield* Clock.currentTimeMillis),
        savedText: input.text,
        savedAt: toIsoUtc(yield* Clock.currentTimeMillis),
      };
      yield* store.write(summary);
      return summary;
    },
  );

  return StandupService.of({ getState, generate, updateItems, save });
});

export const layer = Layer.effect(StandupService, make);

/** Empty state, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  StandupService,
  StandupService.of({
    getState: (input) =>
      Effect.succeed({
        defaultDay: null,
        day: input.day ?? null,
        storedDays: [],
        summary: null,
        hasWork: false,
      }),
    generate: (input) =>
      Effect.fail(
        new StandupError({
          reason: "noWork",
          detail: `No thread, commit or session was recorded on ${input.day}.`,
        }),
      ),
    updateItems: (input) =>
      Effect.succeed({
        day: input.day,
        timeZone: input.timeZone,
        items: input.items,
        generatedAt: "1970-01-01T00:00:00.000Z",
      }),
    save: (input) =>
      Effect.succeed({
        day: input.day,
        timeZone: input.timeZone,
        items: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
        savedText: input.text,
        savedAt: "1970-01-01T00:00:00.000Z",
      }),
  }),
);
