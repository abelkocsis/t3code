import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { StandupSummary } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const MAX_STORED_DAYS = 180;

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
  }
>()("t3/standup/StandupStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(StandupDocument));
  const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(StandupDocument));
  const storePath = path.join(config.stateDir, "standup-summaries.json");

  /**
   * A missing or unreadable file reads as empty. Losing old summaries costs the
   * user their history; failing the read would cost them the feature.
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

  const writeAll = Effect.fn("StandupStore.writeAll")(
    function* (summaries: ReadonlyArray<StandupSummary>) {
      const trimmed = [...summaries]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, MAX_STORED_DAYS);
      const encoded = yield* encodeDocument({ version: CURRENT_VERSION, summaries: trimmed });
      yield* writeFileStringAtomically({ filePath: storePath, contents: `${encoded}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    },
    // A failed write costs the user their history, never the summary they
    // are looking at.
    Effect.ignoreCause(),
  );

  return StandupStore.of({
    readAll,

    read: Effect.fn("StandupStore.read")((day) =>
      readAll.pipe(Effect.map((summaries) => summaries.find((s) => s.day === day) ?? null)),
    ),

    write: Effect.fn("StandupStore.write")((summary) =>
      readAll.pipe(
        Effect.flatMap((summaries) =>
          writeAll([summary, ...summaries.filter((s) => s.day !== summary.day)]),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(StandupStore, make);
