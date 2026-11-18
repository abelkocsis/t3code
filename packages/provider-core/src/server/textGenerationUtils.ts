import { TextGenerationError } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Half an emoji serializes to a lone surrogate escape, which provider JSON parsers reject.
  const last = value.charCodeAt(maxChars - 1);
  const truncated = value.slice(0, last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars);
  return `${truncated}\n\n[truncated]`;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    withoutTrailingPeriod,
  );
  let subject = "";
  for (const { segment } of segments) {
    if (subject.length + segment.length > 72) break;
    subject += segment;
  }
  return subject.trimEnd() || "Update project files";
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const MAX_THREAD_TITLE_CHARS = 120;

export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  let end = MAX_THREAD_TITLE_CHARS - 3;
  const previous = normalized.charCodeAt(end - 1);
  const next = normalized.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${normalized.slice(0, end).trimEnd()}...`;
}

const DAILY_SUMMARY_SOURCES = new Set(["thread", "commit", "pullRequest", "issue", "cliSession"]);
const MAX_DAILY_SUMMARY_ITEMS = 20;
const MAX_DAILY_SUMMARY_ITEM_CHARS = 500;

/**
 * Cleans the bullets a model returned for a daily summary: strips a leading
 * bullet character and quotes, drops blanks and duplicates, caps the length of
 * each item and the count, and maps an unknown source back to `thread`.
 */
/** One bullet as the model wrote it, cleaned the way `sanitizeDailySummaryItems` cleans. Empty when nothing is left. */
function cleanDailySummaryText(raw: string): string {
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
  return text.length <= MAX_DAILY_SUMMARY_ITEM_CHARS
    ? text
    : `${text.slice(0, MAX_DAILY_SUMMARY_ITEM_CHARS - 3).trimEnd()}...`;
}

/**
 * The list an instruction produced. Unlike a generation, it may keep an
 * excluded item and a manual one, so only blank and duplicate rows go.
 */
export function sanitizeDailySummaryInstructItems(
  raw: ReadonlyArray<{
    readonly itemId?: string | undefined;
    readonly text: string;
    readonly source?: string | undefined;
    readonly excluded?: boolean | undefined;
  }>,
): ReadonlyArray<{
  readonly itemId: string;
  readonly text: string;
  readonly source: string;
  readonly excluded: boolean;
}> {
  const seen = new Set<string>();
  const items: Array<{ itemId: string; text: string; source: string; excluded: boolean }> = [];
  for (const candidate of raw) {
    const text = cleanDailySummaryText(candidate.text);
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const source = candidate.source ?? "";
    items.push({
      itemId: candidate.itemId?.trim() ?? "",
      text,
      source: source === "manual" || DAILY_SUMMARY_SOURCES.has(source) ? source : "thread",
      excluded: candidate.excluded === true,
    });
  }
  return items;
}

/** Rules the learn step proposed. Blank and duplicate rules go. */
export function sanitizeDailySummaryRules(
  raw: ReadonlyArray<{ readonly text: string; readonly basis?: string | undefined }>,
): ReadonlyArray<{ readonly text: string; readonly basis: string }> {
  const seen = new Set<string>();
  const rules: Array<{ text: string; basis: string }> = [];
  for (const candidate of raw) {
    const text = cleanDailySummaryText(candidate.text);
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ text, basis: candidate.basis?.replace(/\s+/g, " ").trim() ?? "" });
  }
  return rules;
}

export function sanitizeDailySummaryItems(
  raw: ReadonlyArray<{ readonly text: string; readonly source: string }>,
): ReadonlyArray<{ readonly text: string; readonly source: string }> {
  const seen = new Set<string>();
  const items: Array<{ text: string; source: string }> = [];
  for (const candidate of raw) {
    const text = candidate.text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*•]\s*/, "")
      .replace(/^['"`]+|['"`]+$/g, "")
      .trim();
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      text:
        text.length <= MAX_DAILY_SUMMARY_ITEM_CHARS
          ? text
          : `${text.slice(0, MAX_DAILY_SUMMARY_ITEM_CHARS - 3).trimEnd()}...`,
      source: DAILY_SUMMARY_SOURCES.has(candidate.source) ? candidate.source : "thread",
    });
    if (items.length >= MAX_DAILY_SUMMARY_ITEMS) break;
  }
  return items;
}

function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
