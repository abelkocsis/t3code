/**
 * A factory task is a thread that runs the code-factory flow on its own. The Factory page
 * lists these threads by phase and shows when one waits on a human. The agent writes a
 * free-format report per phase for later agents; the page reads only the marker line.
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
  /** A thread that joined the factory because the user's own pull request got linked to it. */
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

export const ThreadFactory = Schema.Struct({
  input: FactoryInput,
  phase: FactoryPhase,
  /** The sentence the agent put after the phase word, or null. */
  summary: Schema.NullOr(TrimmedString),
  startedAt: IsoDateTime,
  /** When the phase last changed. */
  updatedAt: IsoDateTime,
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
});
export type ThreadFactory = typeof ThreadFactory.Type;

/** The line an agent prints when it enters a phase. Only this line is parsed. */
export const FACTORY_PHASE_MARKER = "FACTORY PHASE:";

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
- Print "${FACTORY_PHASE_MARKER} done" with the pull request link as the last line when the flow ends.`;

export function renderFactoryPrompt(template: string, input: FactoryInput): string {
  return template.replace(/\{\{\s*input\s*\}\}/g, input.value);
}
