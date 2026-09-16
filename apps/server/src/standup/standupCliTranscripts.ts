/**
 * Pulls the day's prompts out of the Claude CLI's own session transcripts.
 *
 * Work done in a terminal never reaches T3 Code's projections, so without this
 * a summary silently drops it. The parser is the same shape as the usage
 * scanner's: one line at a time, cheap substring gate first, and every
 * malformed line skipped rather than failing the scan.
 *
 * @module standupCliTranscripts
 */
import { parseIsoUtc } from "./standupDays.ts";

/** A line longer than this is a pasted file or a tool result, not a prompt. */
const MAX_PROMPT_CHARS = 4_000;

export interface CliPrompt {
  readonly timestampMs: number;
  /** The directory the session ran in, which names the work. */
  readonly cwd: string;
  readonly text: string;
}

/**
 * True when a line is worth handing to `JSON.parse`.
 *
 * Transcripts are mostly tool output and assistant turns. This gate skips most
 * of a file outright and is worth roughly an order of magnitude on a cold scan.
 */
export function mightCarryPrompt(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type": "user"');
}

/**
 * Joins the text a transcript's `message.content` carries.
 *
 * The CLI writes a typed prompt as an array of blocks and an older one as a
 * plain string, so both shapes appear in the same directory. A `tool_result`
 * block is the CLI handing output back to itself as a user turn, so a line that
 * holds one carries no prompt at all and the whole line is dropped.
 */
function readPromptText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "tool_result") return null;
    if (typed.type === "text" && typeof typed.text === "string") texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Reads one transcript line as a user prompt, or returns `null`.
 *
 * A `<...>` opener is an injected reminder rather than something the developer
 * asked for, so it is dropped for the same reason a tool result is.
 */
export function parseCliPromptLine(line: string): CliPrompt | null {
  if (!mightCarryPrompt(line)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as {
    type?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
    isMeta?: unknown;
    message?: { content?: unknown; role?: unknown };
  };
  if (record.type !== "user" || record.isMeta === true) return null;

  const content = readPromptText(record.message?.content);
  if (content === null) return null;
  const text = content.trim();
  if (text.length === 0 || text.length > MAX_PROMPT_CHARS) return null;
  if (text.startsWith("<")) return null;
  if (text.startsWith("Caveat:")) return null;

  const timestamp = record.timestamp;
  if (typeof timestamp !== "string") return null;
  const timestampMs = parseIsoUtc(timestamp);
  if (timestampMs === null) return null;

  return {
    timestampMs,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    text,
  };
}

/**
 * Groups prompts into one entry per working directory, newest directory first.
 *
 * A developer runs many sessions in one repository over a day. The repository
 * is the unit the standup cares about, not the session id.
 */
export function groupPromptsByWorkspace(
  prompts: ReadonlyArray<CliPrompt>,
  limits: { readonly workspaces: number; readonly promptsPerWorkspace: number },
): ReadonlyArray<{ readonly workspace: string; readonly prompts: ReadonlyArray<string> }> {
  const byWorkspace = new Map<string, { latestMs: number; prompts: string[] }>();
  for (const prompt of prompts) {
    const workspace = prompt.cwd.length > 0 ? prompt.cwd : "unknown directory";
    const bucket = byWorkspace.get(workspace) ?? { latestMs: 0, prompts: [] };
    bucket.latestMs = Math.max(bucket.latestMs, prompt.timestampMs);
    if (bucket.prompts.length < limits.promptsPerWorkspace) bucket.prompts.push(prompt.text);
    byWorkspace.set(workspace, bucket);
  }
  return [...byWorkspace.entries()]
    .sort(([, a], [, b]) => b.latestMs - a.latestMs)
    .slice(0, limits.workspaces)
    .map(([workspace, bucket]) => ({ workspace, prompts: bucket.prompts }));
}
