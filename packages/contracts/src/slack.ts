/**
 * A Slack thread a T3 thread is tied to, and the reply sent into it. The Slack conversation is
 * where a review request lives: a message lists the pull requests, reviewers answer in its
 * thread, and every "please re-review" goes back into that same thread.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SlackThreadRef = Schema.Struct({
  /** The message link as pasted, kept so the thread can be opened in Slack. */
  url: TrimmedNonEmptyString,
  channelId: TrimmedNonEmptyString,
  /** The parent message's timestamp, which is what a reply is addressed to. */
  threadTs: TrimmedNonEmptyString,
});
export type SlackThreadRef = typeof SlackThreadRef.Type;

const SLACK_ARCHIVE_PATH = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/;

/**
 * Reads a Slack message link (`https://<team>.slack.com/archives/<channel>/p<ts>`). A link to a
 * reply carries its parent in `thread_ts`, and the reply belongs to that parent's thread.
 */
export function parseSlackThreadUrl(input: string): SlackThreadRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
  const match = SLACK_ARCHIVE_PATH.exec(url.pathname);
  if (!match) return null;
  const [, channelId, seconds, micros] = match;
  if (channelId === undefined || seconds === undefined || micros === undefined) return null;
  const parent = url.searchParams.get("thread_ts")?.trim();
  return {
    url: input.trim(),
    channelId,
    threadTs: parent && /^\d{10}\.\d{6}$/.test(parent) ? parent : `${seconds}.${micros}`,
  };
}

export const SlackThreadReplyInput = Schema.Struct({
  thread: SlackThreadRef,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(5000)),
});
export type SlackThreadReplyInput = typeof SlackThreadReplyInput.Type;

export const SlackThreadReplyResult = Schema.Struct({
  /** The posted reply, as Slack links to it. */
  link: TrimmedNonEmptyString,
});
export type SlackThreadReplyResult = typeof SlackThreadReplyResult.Type;

export class SlackThreadReplyError extends Schema.TaggedError<SlackThreadReplyError>()(
  "SlackThreadReplyError",
  {
    /** "unavailable" when no provider on this server can reach Slack at all. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
