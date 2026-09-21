/**
 * The day's evidence, and how it is written into a prompt.
 *
 * Everything here is pure. The collectors fill these records from the
 * projections, the worktrees, the pull request hosts and the CLI transcripts;
 * this module only shapes them and decides what the model is allowed to see.
 *
 * Every list is capped. A busy day can hold hundreds of turns, and an uncapped
 * prompt would cost more than the summary is worth and would push the earliest
 * work out of the model's attention.
 *
 * @module standupFacts
 */

export const FACT_LIMITS = {
  threads: 40,
  messagesPerThread: 6,
  messageChars: 600,
  commits: 80,
  pullRequests: 40,
  cliSessions: 30,
  promptsPerCliSession: 3,
} as const;

export interface StandupThreadFact {
  readonly threadId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly branch: string | null;
  /** What the user asked for, oldest first. The model's own replies are noise here. */
  readonly userMessages: ReadonlyArray<string>;
  readonly completedTurns: number;
  /** Repository-relative paths the day's checkpoints touched. */
  readonly changedFiles: ReadonlyArray<string>;
}

export interface StandupCommitFact {
  readonly projectTitle: string;
  readonly sha: string;
  readonly subject: string;
}

export interface StandupPullRequestFact {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

export interface StandupCliSessionFact {
  /** The directory the session ran in, which names the work better than the file does. */
  readonly workspace: string;
  readonly prompts: ReadonlyArray<string>;
}

export interface StandupFacts {
  readonly day: string;
  readonly timeZone: string;
  readonly threads: ReadonlyArray<StandupThreadFact>;
  readonly commits: ReadonlyArray<StandupCommitFact>;
  readonly pullRequests: ReadonlyArray<StandupPullRequestFact>;
  readonly cliSessions: ReadonlyArray<StandupCliSessionFact>;
}

/**
 * The `git log` arguments that list only the user's own commits in a window.
 *
 * `--all` walks fetched remote branches too, so the worktree holds the whole
 * team's commits. Each identity value becomes one `--author` match, and git
 * ORs them. `--fixed-strings` keeps a dot in an email address literal. The
 * `refs/t3/*` checkpoints are T3 Code's own commits, never the user's.
 *
 * With no identity there is nothing to match against, so the log stays
 * unfiltered rather than empty.
 */
export function buildCommitLogArgs(input: {
  readonly identity: ReadonlyArray<string>;
  readonly sinceIso: string;
  readonly untilIso: string;
}): ReadonlyArray<string> {
  return [
    "log",
    "--exclude=refs/t3/*",
    "--all",
    "--fixed-strings",
    ...input.identity.map((value) => `--author=${value}`),
    "--pretty=format:%h %s",
    `--since=${input.sinceIso}`,
    `--until=${input.untilIso}`,
    "--max-count=200",
  ];
}

/**
 * True when a name is specific enough to judge a bullet by.
 *
 * A project called `admin` or `general` is an ordinary English word, and a
 * bullet may use it as one. A name that carries a hyphen, an underscore, a dot
 * or a digit is a repository, so a bullet that uses it names where work landed.
 */
function isCheckableName(name: string): boolean {
  return name.length >= 3 && /[-_.0-9]/.test(name);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${escapeForRegExp(name)}(?![A-Za-z0-9-])`, "i").test(text);
}

/**
 * The reasons one generated bullet is not supported by the day's evidence.
 *
 * The prompt forbids invention, and a model still invents. The two claims a
 * reader acts on are the place and the number: a repository name tells them
 * where to look, and a pull request number tells them what to open. Both are
 * checkable against the evidence, so both are checked here, and an item that
 * fails is dropped rather than shown.
 *
 * `knownNames` holds every project in the environment, not only the day's, so
 * a repository the user did not touch that day is recognised as a place and
 * rejected. A name absent from that list cannot be judged and is left alone.
 *
 * An empty result means the bullet is supported.
 */
export function findUnsupportedClaims(input: {
  readonly text: string;
  readonly evidence: string;
  readonly knownNames: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const reasons: string[] = [];

  const evidenceNumbers = new Set(input.evidence.match(/\d+/g) ?? []);
  for (const reference of input.text.match(/#\d+/g) ?? []) {
    const digits = reference.slice(1);
    if (!evidenceNumbers.has(digits)) reasons.push(`${reference} is in no evidence`);
  }

  for (const name of new Set(input.knownNames)) {
    if (!isCheckableName(name)) continue;
    if (!mentionsName(input.text, name)) continue;
    if (!mentionsName(input.evidence, name)) reasons.push(`${name} is in no evidence`);
  }

  return reasons;
}

export function hasStandupWork(facts: StandupFacts): boolean {
  return (
    facts.threads.length > 0 ||
    facts.commits.length > 0 ||
    facts.pullRequests.length > 0 ||
    facts.cliSessions.length > 0
  );
}

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}...`;
}

/**
 * Writes the facts as the evidence block of the prompt.
 *
 * Grouped by source so the model can attribute a bullet, and flat enough that a
 * long day stays readable. Empty sections are left out rather than sent empty,
 * because an empty heading reads as an instruction to invent something.
 */
export function renderStandupFacts(facts: StandupFacts): string {
  const sections: string[] = [];

  if (facts.threads.length > 0) {
    const lines = facts.threads.slice(0, FACT_LIMITS.threads).map((thread) => {
      const parts = [`- [${thread.projectTitle}] ${truncate(thread.title, 160)}`];
      if (thread.branch) parts.push(`  branch: ${thread.branch}`);
      parts.push(`  completed turns: ${thread.completedTurns}`);
      for (const message of thread.userMessages.slice(0, FACT_LIMITS.messagesPerThread)) {
        parts.push(`  asked: ${truncate(message, FACT_LIMITS.messageChars)}`);
      }
      if (thread.changedFiles.length > 0) {
        parts.push(`  touched: ${thread.changedFiles.slice(0, 12).join(", ")}`);
      }
      return parts.join("\n");
    });
    sections.push(`## T3 Code threads\n${lines.join("\n")}`);
  }

  if (facts.commits.length > 0) {
    const lines = facts.commits
      .slice(0, FACT_LIMITS.commits)
      .map((commit) => `- [${commit.projectTitle}] ${commit.sha} ${truncate(commit.subject, 200)}`);
    sections.push(`## Commits\n${lines.join("\n")}`);
  }

  if (facts.pullRequests.length > 0) {
    const lines = facts.pullRequests
      .slice(0, FACT_LIMITS.pullRequests)
      .map((pr) => `- ${pr.repository}#${pr.number} (${pr.state}) ${truncate(pr.title, 200)}`);
    sections.push(`## Pull requests you touched\n${lines.join("\n")}`);
  }

  if (facts.cliSessions.length > 0) {
    const lines = facts.cliSessions.slice(0, FACT_LIMITS.cliSessions).map((session) => {
      const prompts = session.prompts
        .slice(0, FACT_LIMITS.promptsPerCliSession)
        .map((prompt) => `  asked: ${truncate(prompt, FACT_LIMITS.messageChars)}`);
      return [`- ${session.workspace}`, ...prompts].join("\n");
    });
    sections.push(`## Terminal agent sessions\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}
