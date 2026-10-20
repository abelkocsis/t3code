/**
 * The handoff a provider switch leaves for the new provider.
 *
 * The new provider starts a fresh session, so it knows nothing of the thread
 * it continues. The switch writes two files under the state directory: the
 * full transcript, with tool activity, which the agent reads when it needs
 * detail, and a pending prefix with the conversation text, which the first
 * turn of the new thread carries and then deletes. A send that fails keeps
 * the prefix, so the next turn carries it instead.
 *
 * @module providerSwitchHandoff
 */
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

type HandoffMessage = Pick<OrchestrationMessage, "role" | "text" | "createdAt">;
type HandoffActivity = Pick<
  OrchestrationThreadActivity,
  "kind" | "summary" | "payload" | "createdAt"
>;

const conversationMessages = (messages: ReadonlyArray<HandoffMessage>) =>
  messages.filter((message) => message.role !== "system" && message.text.trim().length > 0);

const speaker = (role: HandoffMessage["role"]) => (role === "user" ? "User" : "Agent");

/** Messages and tool activity in time order, for the agent to read on demand. */
export function buildHandoffTranscript(input: {
  readonly title: string;
  readonly sourceProvider: string;
  readonly messages: ReadonlyArray<HandoffMessage>;
  readonly activities: ReadonlyArray<HandoffActivity>;
}): string {
  const entries = [
    ...conversationMessages(input.messages).map((message) => ({
      createdAt: message.createdAt,
      text: `## ${speaker(message.role)} (${message.createdAt})\n\n${message.text.trim()}`,
    })),
    ...input.activities.map((activity) => ({
      createdAt: activity.createdAt,
      text: [
        `### Activity: ${activity.kind} (${activity.createdAt})`,
        "",
        activity.summary,
        ...(activity.payload === undefined || activity.payload === null
          ? []
          : ["", "```json", JSON.stringify(activity.payload, null, 2), "```"]),
      ].join("\n"),
    })),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  return [
    `# Transcript: ${input.title}`,
    "",
    `A ${input.sourceProvider} session wrote this thread before a switch of provider.`,
    "",
    ...entries.map((entry) => `${entry.text}\n`),
  ].join("\n");
}

/** The hidden text the first turn of the new thread starts with. */
export function buildHandoffPrefix(input: {
  readonly sourceProvider: string;
  readonly transcriptPath: string;
  readonly messages: ReadonlyArray<HandoffMessage>;
}): string {
  const conversation = conversationMessages(input.messages)
    .map((message) => `[${speaker(message.role)}]\n${message.text.trim()}`)
    .join("\n\n");
  return [
    "<handoff>",
    `You continue a task that a ${input.sourceProvider} session started in this thread. The user switched providers, so you start without that session's memory.`,
    "The worktree and branch are the same as before. Check the current state of the files before you change them.",
    `The conversation so far is below. The full transcript, with every tool call and its output, is in ${input.transcriptPath}. Read it when you need more detail.`,
    "",
    conversation.length > 0 ? conversation : "(The previous session has no messages.)",
    "</handoff>",
    "",
    "The user's new message follows.",
    "",
  ].join("\n");
}

/** File access for handoffs, bound to this server's state directory. */
export const makeHandoffStore = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = (threadId: ThreadId) => {
    const directory = path.join(config.stateDir, "handoffs", threadId);
    return {
      transcriptPath: path.join(directory, "transcript.md"),
      prefixPath: path.join(directory, "pending-prefix.md"),
    };
  };

  /** Writes both handoff files and returns the transcript path. */
  const write = (input: {
    readonly threadId: ThreadId;
    readonly transcript: string;
    readonly prefix: (transcriptPath: string) => string;
  }) => {
    const { transcriptPath, prefixPath } = paths(input.threadId);
    return writeFileStringAtomically({ filePath: transcriptPath, contents: input.transcript }).pipe(
      Effect.andThen(
        writeFileStringAtomically({ filePath: prefixPath, contents: input.prefix(transcriptPath) }),
      ),
      Effect.as(transcriptPath),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  };

  /** The prefix the thread's next turn must carry, or null when none waits. */
  const readPendingPrefix = (threadId: ThreadId) =>
    fileSystem
      .readFileString(paths(threadId).prefixPath)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));

  const clearPendingPrefix = (threadId: ThreadId) =>
    fileSystem.remove(paths(threadId).prefixPath, { force: true }).pipe(Effect.ignore);

  return { write, readPendingPrefix, clearPendingPrefix };
});
