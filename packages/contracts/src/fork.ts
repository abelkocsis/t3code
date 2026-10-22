/**
 * Per-thread state this fork keeps beside upstream's thread record.
 *
 * Upstream's thread payload and its event unions stay untouched: a fork field
 * there would break decoding on an upstream client and collide with whatever
 * upstream adds next. The fork keeps its own row per thread in its own table
 * and streams it to clients, which join it on the thread id.
 *
 * @module fork
 */
import * as Schema from "effect/Schema";

import { ThreadFolderId, ThreadId } from "./baseSchemas.ts";
import { ThreadFactory } from "./factory.ts";
import { SlackThreadRef } from "./slack.ts";

export const ForkThreadState = Schema.Struct({
  threadId: ThreadId,
  /** The sidebar folder holding this thread. Folder names live in server settings. */
  folderId: Schema.NullOr(ThreadFolderId),
  /** Set while the thread runs as a code-factory task. Null for a plain thread. */
  factory: Schema.NullOr(ThreadFactory),
  /** The Slack thread where this thread's review requests live, told to the agent on every turn. */
  slackThread: Schema.NullOr(SlackThreadRef),
  updatedAt: Schema.String,
});
export type ForkThreadState = typeof ForkThreadState.Type;

/** A fresh row for a thread the fork has not touched yet. */
export const emptyForkThreadState = (threadId: ThreadId): ForkThreadState => ({
  threadId,
  folderId: null,
  factory: null,
  slackThread: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
});

/**
 * What the subscription stream carries: the whole table first, then one row
 * per change. A client replaces the row it already holds for that thread.
 */
export const ForkThreadStateStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    states: Schema.Array(ForkThreadState),
  }),
  Schema.Struct({
    type: Schema.Literal("updated"),
    state: ForkThreadState,
  }),
]);
export type ForkThreadStateStreamEvent = typeof ForkThreadStateStreamEvent.Type;

export const ForkThreadStateSubscribeInput = Schema.Struct({});
export type ForkThreadStateSubscribeInput = typeof ForkThreadStateSubscribeInput.Type;

export const ForkThreadSetFolderInput = Schema.Struct({
  threadId: ThreadId,
  /** Null takes the thread out of its folder. */
  folderId: Schema.NullOr(ThreadFolderId),
});
export type ForkThreadSetFolderInput = typeof ForkThreadSetFolderInput.Type;

export const ForkThreadSetFactoryInput = Schema.Struct({
  threadId: ThreadId,
  /** Null takes the thread off the Factory page; the thread itself stays. */
  factory: Schema.NullOr(ThreadFactory),
});
export type ForkThreadSetFactoryInput = typeof ForkThreadSetFactoryInput.Type;
export const ForkThreadSetSlackThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** Null removes the link. */
  slackThread: Schema.NullOr(SlackThreadRef),
});
export type ForkThreadSetSlackThreadInput = typeof ForkThreadSetSlackThreadInput.Type;

export class ForkThreadStateError extends Schema.TaggedError<ForkThreadStateError>()(
  "ForkThreadStateError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
