/**
 * Posts a reply in a Slack thread through the Slack connector of the Claude account this
 * instance is signed in with. T3 holds no Slack credentials of its own: the connector does, and
 * only a Claude run can use it. The run is locked down to the one send tool, and its answer is
 * checked against the thread it was asked to post in.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ClaudeSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeClaudeEnvironment } from "./ClaudeHome.ts";

const SLACK_SEND_TOOL = "mcp__claude_ai_Slack__slack_send_message";
const SLACK_REPLY_TIMEOUT_MS = 120_000;

export class ClaudeSlackReplyError extends Schema.TaggedError<ClaudeSlackReplyError>()(
  "ClaudeSlackReplyError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export interface ClaudeSlackReplyInput {
  readonly channelId: string;
  readonly threadTs: string;
  readonly text: string;
}

const ReplyOutcome = Schema.Struct({
  sent: Schema.Boolean,
  link: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

const OUTCOME_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    sent: { type: "boolean" },
    link: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
  },
  required: ["sent", "link", "error"],
  additionalProperties: false,
});

const ClaudeOutput = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ structured_output: Schema.Unknown }),
    Schema.Array(
      Schema.Struct({ type: Schema.String, structured_output: Schema.optionalKey(Schema.Unknown) }),
    ),
  ]),
);
const decodeClaudeOutput = Schema.decodeUnknownEffect(ClaudeOutput);
const decodeOutcome = Schema.decodeUnknownEffect(ReplyOutcome);

export function buildSlackReplyPrompt(input: ClaudeSlackReplyInput): string {
  return [
    `Post one reply in a Slack thread by calling the ${SLACK_SEND_TOOL} tool exactly once with:`,
    `- channel_id: ${input.channelId}`,
    `- thread_ts: ${input.threadTs}`,
    "- message: the text between the BEGIN and END lines below, character for character.",
    "Do not change, add to, or summarise the text, and do not call any other tool.",
    "Then answer with sent, the message link the tool returned, and any error it reported.",
    "BEGIN",
    input.text,
    "END",
  ].join("\n");
}

/** A link into the right thread is the proof; the model's own "sent" is not. */
export function isReplyLinkForThread(link: string, input: ClaudeSlackReplyInput): boolean {
  return link.includes(`/archives/${input.channelId}/`);
}

export const makeClaudeSlackReply = Effect.fn("makeClaudeSlackReply")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const fail = (detail: string) => new ClaudeSlackReplyError({ detail });
  const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError(() => fail("Could not read the Claude CLI output.")),
    );

  const run = (input: ClaudeSlackReplyInput) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          OUTCOME_JSON_SCHEMA,
          "--model",
          "haiku",
          "--settings",
          '{"disableAllHooks":true}',
          // No built-in tools, and every MCP tool but the send is refused without a prompt.
          "--tools",
          "",
          "--allowedTools",
          SLACK_SEND_TOOL,
          "--disable-slash-commands",
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: claudeEnvironment,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.encodeText(Stream.make(buildSlackReplyPrompt(input))) },
          }),
        )
        .pipe(Effect.mapError(() => fail("Could not start the Claude CLI.")));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collect(child.stdout),
          collect(child.stderr),
          child.exitCode.pipe(Effect.mapError(() => fail("The Claude CLI did not exit cleanly."))),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* fail(detail ? `Claude CLI failed: ${detail}` : "Claude CLI failed.");
      }
      const output = yield* decodeClaudeOutput(stdout.trim()).pipe(
        Effect.mapError(() => fail("Claude returned an answer T3 could not read.")),
      );
      const structured =
        "structured_output" in output
          ? output.structured_output
          : output.findLast((message) => message.structured_output !== undefined)
              ?.structured_output;
      const outcome = yield* decodeOutcome(structured).pipe(
        Effect.mapError(() => fail("Claude returned an answer T3 could not read.")),
      );
      if (!outcome.sent || outcome.link === null) {
        return yield* fail(outcome.error ?? "Slack did not confirm the message.");
      }
      if (!isReplyLinkForThread(outcome.link, input)) {
        return yield* fail(`Slack posted somewhere unexpected: ${outcome.link}`);
      }
      return { link: outcome.link };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(SLACK_REPLY_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("Sending to Slack timed out.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  return run;
});
