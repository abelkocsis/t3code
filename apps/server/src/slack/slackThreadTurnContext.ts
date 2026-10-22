import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, type SlackThreadRef } from "@t3tools/contracts";

/**
 * Appends a note about the thread's linked Slack thread to the provider turn text. The note goes
 * on every turn rather than once, so it survives session restarts and compaction, and stops as
 * soon as the link is removed. It never shows in the transcript. Slash commands and turns that
 * would exceed the input limit are sent without the note, so the note never becomes command args.
 */
export function appendSlackThreadTurnContext(
  input: string | undefined,
  slackThread: SlackThreadRef | null | undefined,
): string | undefined {
  if (!slackThread || input?.startsWith("/")) return input;
  const note = [
    `[This conversation is linked to a Slack thread: ${slackThread.url} (channel ${slackThread.channelId}, thread ts ${slackThread.threadTs}).`,
    "When the user mentions Slack, assume they mean this thread.",
    "Read it with your Slack tools when the task needs its context.",
    "Never post, reply, or react in Slack unless the user asks you to.]",
  ].join(" ");
  const combined = input ? `${input}\n\n${note}` : note;
  return combined.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS ? combined : input;
}
