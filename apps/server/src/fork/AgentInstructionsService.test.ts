import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentInstructionsService from "./AgentInstructionsService.ts";

type DeepPartialSettings = Parameters<typeof ServerSettingsService.layerTest>[0];

/** Runs the body with a throwaway home directory and the given settings and environment. */
const withService = <A, E>(
  body: (input: {
    readonly service: AgentInstructionsService.AgentInstructionsService["Service"];
    readonly home: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: {
    readonly settings?: DeepPartialSettings;
    readonly environment?: (home: string) => NodeJS.ProcessEnv;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-instructions-" });
    const service = yield* AgentInstructionsService.make.pipe(
      Effect.provide(ServerSettingsService.layerTest(options.settings ?? {})),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, options.environment?.(home) ?? {}),
    );
    return yield* body({ service, home });
  }).pipe(Effect.scoped);

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

it.layer(NodeServices.layer)("agent instructions", (it) => {
  it.effect("reads a missing global file as empty, then creates it on save", () =>
    withService(({ service, home }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const expected = path.join(home, ".claude", "CLAUDE.md");

        const before = yield* service.readGlobal(claude);
        assert.deepEqual(before, { path: expected, contents: "", exists: false });

        yield* service.writeGlobal(claude, "Be brief.\n");
        assert.equal(yield* fs.readFileString(expected), "Be brief.\n");
        assert.deepEqual(yield* service.readGlobal(claude), {
          path: expected,
          contents: "Be brief.\n",
          exists: true,
        });
      }),
    ),
  );

  it.effect("follows CODEX_HOME for Codex", () =>
    withService(
      ({ service, home }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const file = yield* service.readGlobal(codex);
          assert.equal(file.path, path.join(home, "codex-work", "AGENTS.md"));
        }),
      { environment: (home) => ({ CODEX_HOME: `${home}/codex-work` }) },
    ),
  );

  it.effect("prefers the instance's own home over the environment", () =>
    withService(
      ({ service, home }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const file = yield* service.readGlobal(ProviderInstanceId.make("claude-work"));
          assert.equal(file.path, path.join(home, "work-claude", "CLAUDE.md"));
        }),
      {
        settings: {
          providerInstances: {
            ["claude-work" as ProviderInstanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: "~/work-claude" },
            },
          },
        },
        environment: () => ({ CLAUDE_CONFIG_DIR: "/elsewhere" }),
      },
    ),
  );

  it.effect("refuses a provider with no known instructions file", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.readGlobal(ProviderInstanceId.make("cursor")));
        assert.equal(error.reason, "unsupportedProvider");
      }),
    ),
  );
});
