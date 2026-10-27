/**
 * Daily summary contract.
 *
 * The server assembles one day of work from every source it can already read -
 * its own orchestration projections, `git log` in each project worktree, the
 * repositories' pull requests and issues, and the provider CLIs' on-disk
 * session transcripts - and asks the model to write it up as standup bullets.
 *
 * A summary is a list of items rather than one blob of text, so the client can
 * drop a bullet or add one without asking the model again. The text the user
 * finally saves is kept, and later generations receive the most recent saved
 * texts as style examples.
 *
 * @module standup
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The editable part of the daily summary prompt. The server adds the JSON output format, the
 * day, the kept and removed items, and the evidence around it.
 */
export const DEFAULT_DAILY_SUMMARY_INSTRUCTIONS = `You write a developer's daily standup update.

Rules:
- Keep each item short. Twenty words maximum, one line, no paragraph.
- Say what the user achieved, in the past tense. Name the result, not the activity.
- Cut every clause the reader does not need. The user asks when they want detail.
- Do not chain clauses with \`and\`, \`which\`, \`so\` or \`because\`. Split them into separate items instead.
- Write one item per stream of work, not one per commit or per thread.
- Group work on the same repository, feature or incident into one item, or into a few short items.
- Keep the repository or project name when it tells the reader where the work landed.
- Keep pull request and issue numbers when the evidence shows them.
- Name a blocker when the evidence shows one. Keep it to one short item.
- Write plain sentences or fragments. No headings, no bold, no leading bullet character.
- Use only the evidence below. Never invent work, numbers or names.
- Report only what the user did. A pull request number in a commit subject is a reference, not proof that the user merged it.
- Report every stream of work the evidence shows, then stop. Eight items is the maximum.
- Never pad the list. Two well-supported items beat eight invented ones.`;

/**
 * A calendar day in the user's reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side, in the zone the client sends, so a late-night
 * turn lands on the day the user experienced rather than the UTC day.
 */
const STANDUP_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const StandupDay = TrimmedNonEmptyString.check(Schema.isPattern(STANDUP_DAY_PATTERN)).pipe(
  Schema.brand("StandupDay"),
);
export type StandupDay = typeof StandupDay.Type;

/**
 * Where the evidence behind a bullet came from.
 *
 * The client shows this so the user can judge a bullet without opening the
 * thread or the repository. `manual` marks a bullet the user typed.
 */
export const StandupItemSource = Schema.Literals([
  "thread",
  "commit",
  "pullRequest",
  "issue",
  "cliSession",
  "manual",
]);
export type StandupItemSource = typeof StandupItemSource.Type;

export const StandupItem = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  source: StandupItemSource,
  /**
   * An excluded item stays in the list instead of being deleted, so the user
   * can put it back and so a regeneration can keep the same choice.
   */
  excluded: Schema.Boolean,
});
export type StandupItem = typeof StandupItem.Type;

export const StandupSummary = Schema.Struct({
  day: StandupDay,
  timeZone: TrimmedNonEmptyString,
  items: Schema.Array(StandupItem),
  /** UTC instant the model last wrote these items. */
  generatedAt: TrimmedNonEmptyString,
  /** The text the user last copied out, after any edit. */
  savedText: Schema.optional(Schema.String),
  savedAt: Schema.optional(TrimmedNonEmptyString),
});
export type StandupSummary = typeof StandupSummary.Type;

export const StandupStateInput = Schema.Struct({
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a daylight-saving boundary.
   */
  timeZone: TrimmedNonEmptyString,
  /**
   * Day to load. Omitted on first open, which makes the server answer with the
   * last day that holds work.
   */
  day: Schema.optional(StandupDay),
});
export type StandupStateInput = typeof StandupStateInput.Type;

export const StandupState = Schema.Struct({
  /**
   * The last day that holds any work, which is the day the panel opens on.
   * `null` when the environment has recorded nothing yet.
   */
  defaultDay: Schema.NullOr(StandupDay),
  /** The requested day, or `defaultDay` when the client sent none. */
  day: Schema.NullOr(StandupDay),
  /** Days that already hold a stored summary, newest first. */
  storedDays: Schema.Array(StandupDay),
  /**
   * The stored summary for `day`. `null` means nothing was generated for that
   * day yet, and the client offers a Generate button instead of running one.
   */
  summary: Schema.NullOr(StandupSummary),
  /** False when the day holds no thread, commit or session at all. */
  hasWork: Schema.Boolean,
});
export type StandupState = typeof StandupState.Type;

export const StandupGenerateInput = Schema.Struct({
  day: StandupDay,
  timeZone: TrimmedNonEmptyString,
});
export type StandupGenerateInput = typeof StandupGenerateInput.Type;

export const StandupUpdateItemsInput = Schema.Struct({
  day: StandupDay,
  timeZone: TrimmedNonEmptyString,
  items: Schema.Array(StandupItem),
});
export type StandupUpdateItemsInput = typeof StandupUpdateItemsInput.Type;

export const StandupSaveInput = Schema.Struct({
  day: StandupDay,
  timeZone: TrimmedNonEmptyString,
  /** The final text, exactly as the user copied it. */
  text: Schema.String,
});
export type StandupSaveInput = typeof StandupSaveInput.Type;

export class StandupError extends Schema.TaggedError<StandupError>()("StandupError", {
  reason: Schema.Literals([
    "collectFailed",
    "generateFailed",
    "storeFailed",
    "invalidDay",
    "noWork",
  ]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Standup summary failed (${this.reason}): ${this.detail}`;
  }
}
