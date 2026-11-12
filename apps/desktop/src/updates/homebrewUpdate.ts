import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Stream from "effect/Stream";

class HomebrewUpdateError extends Schema.TaggedError<HomebrewUpdateError>()("HomebrewUpdateError", {
  message: Schema.String,
}) {}

const cask = "dlc-link/tap/t3-code-bitsafe";

const run = Effect.fn("HomebrewUpdate.run")(function* (command: string, args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" }));
      const [stdout, stderr, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* new HomebrewUpdateError({ message: `Homebrew update failed: ${stderr}` });
      return stdout;
    }),
  );
});
const brewPath = (arch: string) =>
  arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
const HomebrewInfo = Schema.fromJsonString(
  Schema.Struct({
    casks: Schema.Array(Schema.Struct({ version: Schema.String })),
  }),
);
const decodeHomebrewInfo = Schema.decodeEffect(HomebrewInfo);
const readVersion = Effect.fn("HomebrewUpdate.readVersion")(function* (arch: string) {
  const output = yield* run(brewPath(arch), ["info", "--json=v2", "--cask", cask]);
  const info = yield* decodeHomebrewInfo(output);
  const version = info.casks[0]?.version;
  if (!version)
    return yield* new HomebrewUpdateError({ message: "Homebrew returned no cask version." });
  return version;
});

export const checkHomebrewUpdate = Effect.fn("HomebrewUpdate.check")(function* (
  currentVersion: string,
  arch: string,
) {
  yield* run(brewPath(arch), ["update"]);
  const version = yield* readVersion(arch);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
});

export const downloadHomebrewUpdate = Effect.fn("HomebrewUpdate.download")(function* (
  arch: string,
) {
  yield* run(brewPath(arch), ["fetch", "--cask", cask]);
});

export const installHomebrewUpdate = Effect.fn("HomebrewUpdate.install")(function* (
  appBundle: string,
  expectedVersion: string,
  arch: string,
) {
  const brew = brewPath(arch);
  yield* run(brew, ["list", "--cask", cask]);
  yield* run(brew, ["update"]);
  yield* run(brew, ["upgrade", "--greedy", "--cask", cask]);
  const version = yield* run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleShortVersionString",
    `${appBundle}/Contents/Info.plist`,
  ]);
  if (version.trim() !== expectedVersion) {
    return yield* new HomebrewUpdateError({
      message: `Homebrew has not installed ${expectedVersion}. The tap may still need its release update. Installed: ${version.trim()}.`,
    });
  }
});
