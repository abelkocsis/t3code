import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

class HomebrewUpdateError extends Schema.TaggedError<HomebrewUpdateError>()("HomebrewUpdateError", {
  message: Schema.String,
}) {}

const cask = "dlc-link/tap/t3-code-bitsafe";

export const installHomebrewUpdate = Effect.fn("HomebrewUpdate.install")(function* (
  appBundle: string,
  expectedVersion: string,
  arch: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.fn("HomebrewUpdate.run")(function* (command: string, args: string[]) {
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
  const brew = arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
  yield* run(brew, ["list", "--cask", cask]);
  yield* run(brew, ["update"]);
  yield* run(brew, ["upgrade", "--cask", cask]);
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
