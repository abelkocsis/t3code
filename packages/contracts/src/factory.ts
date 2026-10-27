/**
 * A factory task is a thread that runs the code-factory flow on its own. The Factory page
 * lists these threads by phase and shows when one waits on a human. The agent writes a
 * free-format report per phase for later agents; the page reads only the marker line.
 *
 * The state lives in the fork's own per-thread row (see fork.ts), never in upstream's
 * thread payload.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

/**
 * The phases in the order the flow runs them. A small task may skip the two spec phases. The
 * agent reports the first nine; the server moves a task through the review stages from the
 * pull request state, and the human marks "under-review" and merges.
 */
export const FACTORY_PHASES = [
  "requirements",
  "product-spec",
  "implementation-spec",
  "implementation",
  "review",
  "fix",
  "converged",
  "human-gate",
  "done",
  "ready-for-review",
  "under-review",
  "ready-to-merge",
  "merged",
] as const;
export const FactoryPhase = Schema.Literals(FACTORY_PHASES);
export type FactoryPhase = typeof FactoryPhase.Type;

export const FACTORY_PHASE_LABELS: Record<FactoryPhase, string> = {
  requirements: "Requirements",
  "product-spec": "Product spec",
  "implementation-spec": "Implementation spec",
  implementation: "Implementation",
  review: "Review",
  fix: "Fix",
  converged: "Converged",
  "human-gate": "Human gate",
  done: "Done",
  "ready-for-review": "Ready for review",
  "under-review": "Under review",
  "ready-to-merge": "Ready to merge",
  merged: "Merged",
};

/** Stages the server drives from the pull request, after the agent's own flow ends. */
export const FACTORY_REVIEW_PHASES: ReadonlyArray<FactoryPhase> = [
  "ready-for-review",
  "under-review",
  "ready-to-merge",
];

/** Stages where the task is over. The page lists these as completed. */
export const FACTORY_COMPLETED_PHASES: ReadonlyArray<FactoryPhase> = ["done", "merged"];

export const FactoryInputKind = Schema.Literals([
  "github-issue",
  "notion-page",
  "free-text",
  /** An existing thread added to the factory by hand, with its pull request as the input. */
  "pull-request",
]);
export type FactoryInputKind = typeof FactoryInputKind.Type;

export const FactoryInput = Schema.Struct({
  kind: FactoryInputKind,
  /** The issue URL, the Notion page URL, or the text as typed. */
  value: TrimmedNonEmptyString,
});
export type FactoryInput = typeof FactoryInput.Type;

/**
 * What the review stages last reacted to, so the same comment, failed check, or stale base
 * is handled once. Reset when the human marks the task under review.
 */
export const FactoryReviewMemo = Schema.Struct({
  seenUpdatedAt: Schema.NullOr(IsoDateTime),
  seenUnresolved: NonNegativeInt,
  seenChecksState: Schema.NullOr(TrimmedString),
  seenMergeState: Schema.NullOr(TrimmedString),
  /**
   * The newest human review the agent was sent, by the host's review id. Null: none yet.
   * Absent on a memo written before this existed.
   */
  seenReviewId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * The newest conversation comment by someone else the agent was sent, by the host's comment
   * id. Null: none yet. Absent on a memo written before this existed.
   */
  seenCommentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type FactoryReviewMemo = typeof FactoryReviewMemo.Type;

/** A folder on the Factory page. Lives in server settings so it outlives its tasks. */
export const FactoryFolder = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type FactoryFolder = typeof FactoryFolder.Type;

export const FactoryBlockingPullRequest = Schema.Struct({
  url: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: NonNegativeInt,
});
export type FactoryBlockingPullRequest = typeof FactoryBlockingPullRequest.Type;

/** How far ahead a task snoozes while it waits on another pull request: a year is "until woken". */
export const FACTORY_BLOCKED_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Review work the server found but did not start, because token saving is on. The human
 * starts it from the Factory page, which sends `message` to the agent.
 */
/** Why the review sweep found work: a failed check, a stale base, or reviewer feedback. */
export const FactoryWorkCause = Schema.Literals(["ci", "stale-base", "comments"]);
export type FactoryWorkCause = typeof FactoryWorkCause.Type;

export const FactoryPendingWorkPart = Schema.Struct({
  cause: FactoryWorkCause,
  summary: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type FactoryPendingWorkPart = typeof FactoryPendingWorkPart.Type;

export const FactoryPendingWork = Schema.Struct({
  /** What needs doing, in one sentence for the task row. */
  summary: TrimmedNonEmptyString,
  /** The message the agent gets when the work starts. */
  message: TrimmedNonEmptyString,
  /**
   * The causes `message` is made of, so a cause that clears on its own can leave the held
   * work. Absent on work held before parts existed.
   */
  parts: Schema.optional(Schema.Array(FactoryPendingWorkPart)),
});
export type FactoryPendingWork = typeof FactoryPendingWork.Type;

/**
 * The message that starts held work. The work waited, so the pull request may have moved on
 * since: the agent also checks it whole and handles everything else in the same turn.
 */
export function factoryHeldWorkMessage(pending: FactoryPendingWork): string {
  return [
    pending.message,
    `This work waited before it started, so check the whole pull request before you print the phase marker. Rebase onto the base branch if it moved ahead or conflicts. Fix CI if it fails. Read every review, open review thread, and conversation comment you have not answered yet, and handle each one: fix it or push back with a reason, reply on the pull request, and resolve the conversations you fixed. If you changed code, post a short report under the pull request. Print one "${FACTORY_PHASE_MARKER}" line for the whole set.`,
  ].join("\n\n");
}

export const ThreadFactory = Schema.Struct({
  input: FactoryInput,
  phase: FactoryPhase,
  /** The sentence the agent put after the phase word, or null. */
  summary: Schema.NullOr(TrimmedString),
  startedAt: IsoDateTime,
  /** When the phase last changed. */
  updatedAt: IsoDateTime,
  /** The phase the task was in when it last stopped at a human gate. */
  gatedFrom: Schema.optional(FactoryPhase),
  review: Schema.optional(Schema.NullOr(FactoryReviewMemo)),
  /** The Factory page folder, or null when the task sits below the folders. */
  folderId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** How many times the human sent it to reviewers. Zero until the first review request. */
  reviewRound: Schema.optional(NonNegativeInt),
  /** Also list the thread in the sidebar. Off by default: the Factory page is its home. */
  showInSidebar: Schema.optional(Schema.Boolean),
  /**
   * The pull request this task sleeps behind. The thread is snoozed far ahead while this is
   * set; the server wakes it when that pull request merges.
   */
  blockedBy: Schema.optional(Schema.NullOr(FactoryBlockingPullRequest)),
  /** Review work waiting for the human to start it. Set only while token saving is on. */
  pendingWork: Schema.optional(Schema.NullOr(FactoryPendingWork)),
});
export type ThreadFactory = typeof ThreadFactory.Type;

/**
 * The factory state after the thread wakes. A wake from any source, such as a new message,
 * ends the wait on a blocking pull request, so the hourly merge check stops watching it.
 */
export function factoryAfterWake<F extends ThreadFactory | null | undefined>(factory: F): F {
  return factory?.blockedBy ? { ...factory, blockedBy: null } : factory;
}

/** The line an agent prints when it enters a phase. Only this line is parsed. */
export const FACTORY_PHASE_MARKER = "FACTORY PHASE:";

/**
 * Commit signing fails only on the developer's machine, and only they can fix it. A partial
 * push would leave the pull request half updated, so the agent pushes nothing and stops.
 */
export const FACTORY_SIGNING_RULE = `If a commit fails to sign, push nothing from this round, not even the commits that signed. The cause is always local, and only I can fix it. Do not turn signing off or work around it. Leave the changes in place, print "${FACTORY_PHASE_MARKER} human-gate", and ask me to fix commit signing.`;

const MARKER_LINE = /^\s*(?:[*_`#>\-\s]*)FACTORY PHASE:\s*([a-z-]+)\b[\s:*_`–-]*(.*?)[\s*_`]*$/i;

/**
 * Reads the last phase marker in an assistant message. Markdown emphasis and list markers
 * around the line are ignored. Returns null when no line names a known phase.
 */
export function parseFactoryPhaseMarker(
  text: string,
): { phase: FactoryPhase; summary: string | null } | null {
  let found: { phase: FactoryPhase; summary: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = MARKER_LINE.exec(line);
    if (!match) continue;
    const word = match[1]?.toLowerCase();
    const phase = FACTORY_PHASES.find((candidate) => candidate === word);
    if (!phase) continue;
    const summary = match[2]?.trim() ?? "";
    found = { phase, summary: summary.length > 0 ? summary : null };
  }
  return found;
}

/** Reads the kind of a factory input from the text the user typed. */
export function classifyFactoryInput(text: string): FactoryInput | null {
  const value = text.trim();
  if (value.length === 0) return null;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url && url.protocol === "https:") {
    if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/issues\/\d+/.test(url.pathname)) {
      return { kind: "github-issue", value };
    }
    if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(url.pathname)) {
      return { kind: "pull-request", value };
    }
    if (url.hostname === "www.notion.so" || url.hostname.endsWith(".notion.site")) {
      return { kind: "notion-page", value };
    }
  }
  return { kind: "free-text", value };
}

/**
 * The GitHub `owner/repo` the input points at, or null. Issue and pull request URLs name it
 * outright; free text that starts with any GitHub URL, such as a file link, names it too.
 */
export function factoryInputRepository(input: FactoryInput): string | null {
  if (input.kind === "notion-page") return null;
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#\s]|$)/.exec(
    input.value,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/**
 * The first message of a factory task. `{{input}}` is replaced with the task input. Stored in
 * server settings so the text can be tuned without a release.
 */
export const DEFAULT_FACTORY_PROMPT_TEMPLATE = `Run the code-factory flow on this task without waiting for me between phases.

Task:
{{input}}

Rules:
- Load the darkfactory skill and follow it. Size the task first. A small and easy task may skip the product spec and the implementation spec.
- Work on a branch in this worktree. Open a pull request when the implementation is ready.
- At the end of each phase, write a short report: what was done, what was considered and rejected, which agents and models ran, and at what effort. Choose the format yourself. Post the report as a comment under the pull request once one exists. Earlier reports go under the pull request as soon as it opens.
- Each time you enter a phase, print one line on its own that starts with "${FACTORY_PHASE_MARKER}" followed by the phase word and one sentence. The phase words are: ${FACTORY_PHASES.join(", ")}. Example: "${FACTORY_PHASE_MARKER} review Three reviewers read the diff."
- Ask me a question only when the flow needs a human decision. Print "${FACTORY_PHASE_MARKER} human-gate" before you ask.
- ${FACTORY_SIGNING_RULE}
- Print "${FACTORY_PHASE_MARKER} done" with the pull request link as the last line when the flow ends.`;

/**
 * The task text for an existing thread added to the factory by hand, rendered into the
 * prompt template. The agent works out where the thread stands instead of starting over.
 */
export const FACTORY_JOIN_TASK = `The work already done in this thread. Do not start over.
First decide which phase the work is in: read this conversation, the branch, and any pull request. Print the marker line for that phase with one sentence.
If the phase is unclear, print "${FACTORY_PHASE_MARKER} human-gate" and ask me.
Then continue the flow from that phase.`;

export function renderFactoryPrompt(template: string, input: FactoryInput): string {
  return template.replace(/\{\{\s*input\s*\}\}/g, input.value);
}
