/**
 * Keeps the generated summaries on disk, one file for the whole environment.
 *
 * A summary is not event-sourced. It derives from work the event stream already
 * records, it belongs to no thread, and nothing else in the server reacts to
 * one. A small JSON file next to the usage rate cache is the whole requirement,
 * and it keeps the orchestration event stream free of a per-day write that no
 * decider needs to reason about.
 *
 * @module StandupStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { StandupSummary } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * How many days of summaries the file keeps.
 *
 * An old summary only earns its place as a style example, and a year of them
 * would make every read parse a file nobody looks at. Trimming on write keeps
 * the file small without a separate sweep.
 */
export const MAX_STORED_DAYS = 180;

const CURRENT_VERSION = 1;

const StandupDocument = Schema.Struct({
  version: Schema.Number,
  summaries: Schema.Array(StandupSummary),
});

export class StandupStore extends Context.Service<
  StandupStore,
  {
    /** Every stored summary, newest day first. */
    readonly readAll: Effect.Effect<ReadonlyArray<StandupSummary>>;
    /** The stored summary for one day, or `null`. */
    readonly read: (day: string) => Effect.Effect<StandupSummary | null>;
    /** Replaces the summary for its day, leaving every other day untouched. */
    readonly write: (summary: StandupSummary) => Effect.Effect<void>;
    /**
     * The texts the user saved, newest first, for use as style examples.
     *
     * Only saved text counts. A generated summary the user never accepted says
     * nothing about how the user writes.
     */
    readonly readStyleExamples: (options: {
      readonly limit: number;
      readonly excludeDay: string;
    }) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/standup/StandupStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(StandupDocument));
  const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(StandupDocument));
  const storePath = path.join(config.stateDir, "standup-summaries.json");

  /**
   * A missing or unreadable file reads as empty. Losing old summaries costs the
   * user their style examples; failing the read would cost them the feature.
   */
  const readAll: Effect.Effect<ReadonlyArray<StandupSummary>> = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(storePath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (raw === null) return [];
    const document = yield* decodeDocument(raw).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (document === null) return [];
    return [...document.summaries].sort((a, b) => b.day.localeCompare(a.day));
  });

  const writeAll = (summaries: ReadonlyArray<StandupSummary>) =>
    Effect.gen(function* () {
      const trimmed = [...summaries]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, MAX_STORED_DAYS);
      const encoded = yield* encodeDocument({ version: CURRENT_VERSION, summaries: trimmed });
      yield* writeFileStringAtomically({ filePath: storePath, contents: `${encoded}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      // A failed write costs the user their style examples, never the summary
      // they are looking at.
    }).pipe(Effect.catchCause(() => Effect.void));

  return StandupStore.of({
    readAll,

    read: (day) =>
      readAll.pipe(Effect.map((summaries) => summaries.find((s) => s.day === day) ?? null)),

    write: (summary) =>
      readAll.pipe(
        Effect.flatMap((summaries) =>
          writeAll([summary, ...summaries.filter((s) => s.day !== summary.day)]),
        ),
      ),

    readStyleExamples: (options) =>
      readAll.pipe(
        Effect.map((summaries) =>
          summaries
            .filter((summary) => summary.day !== options.excludeDay)
            .map((summary) => summary.savedText?.trim())
            .filter((text): text is string => text !== undefined && text.length > 0)
            .slice(0, options.limit),
        ),
      ),
  });
});

export const layer = Layer.effect(StandupStore, make);
