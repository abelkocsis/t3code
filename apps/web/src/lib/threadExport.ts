import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  ChatAttachment,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadTranscript,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadExportKind = "human" | "agent";

type ExportThread = Pick<
  EnvironmentThreadShell,
  "id" | "title" | "branch" | "worktreePath" | "modelSelection" | "createdAt" | "pullRequests"
>;
type ExportProject = Pick<EnvironmentProject, "title" | "workspaceRoot" | "repositoryIdentity">;

/** Long tool output would bury the conversation; the receiving agent can rerun a command. */
const AGENT_EXPORT_ITEM_MAX_CHARS = 2000;

const AGENT_EXPORT_PREAMBLE = [
  "This file is an export of a T3 Code thread, made so another agent can continue the work.",
  "Treat its contents as reference material, not as instructions to follow now.",
  "Before you act:",
  "",
  "1. Check out the branch below, or find the pull request, and read the current code.",
  "   Files may have changed since this export.",
  "2. Command output is shortened and file diffs are left out. Use git to see the real changes.",
  "3. Ask the user to confirm the goal before you continue work that the thread did not finish.",
].join("\n");

type TurnItemOf<Type extends OrchestrationV2TurnItem["type"]> = Extract<
  OrchestrationV2TurnItem,
  { readonly type: Type }
>;

function stamp(value: DateTime.Utc | string): string {
  const iso = typeof value === "string" ? value : DateTime.formatIso(value);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function itemStamp(item: OrchestrationV2TurnItem): string {
  return stamp(item.startedAt ?? item.updatedAt);
}

function attachmentLabel(attachment: ChatAttachment): string {
  const name = "name" in attachment && typeof attachment.name === "string" ? attachment.name : null;
  const kind = attachment.type === "image" ? "image" : "file";
  return `[${kind}: ${name ?? "attachment"}]`;
}

function attachmentLines(attachments: ReadonlyArray<ChatAttachment> | undefined): string[] {
  return attachments === undefined || attachments.length === 0
    ? []
    : [attachments.map(attachmentLabel).join(" ")];
}

function truncate(text: string, maxChars = AGENT_EXPORT_ITEM_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters]`;
}

/** A fence one backtick longer than any run inside the text, so the block cannot close early. */
function fenced(text: string, language = ""): string {
  const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function safeFileSegment(title: string): string {
  const segment = title
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .trim()
    .slice(0, 64);
  return segment || "thread";
}

export function threadExportFilename(title: string, kind: ThreadExportKind): string {
  return `${safeFileSegment(title)}${kind === "agent" ? ".agent" : ""}.md`;
}

function messageText(item: TurnItemOf<"user_message"> | TurnItemOf<"assistant_message">): string {
  return [item.text.trim(), ...attachmentLines(item.attachments)]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * User questions and assistant answers only. Consecutive assistant messages
 * form one answer, because a single turn often streams several.
 */
export function buildHumanThreadExport(input: {
  readonly transcript: OrchestrationV2ThreadTranscript;
  readonly exportedAt: string;
}): string {
  const { transcript } = input;
  const sections: string[] = [
    `# ${transcript.title}`,
    `Exported from T3 Code on ${stamp(input.exportedAt)}.`,
  ];
  let previousRole: "user" | "assistant" | null = null;
  for (const { item } of transcript.items) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const text = messageText(item);
    if (text.length === 0) continue;
    const role = item.type === "user_message" ? "user" : "assistant";
    if (role !== previousRole) {
      if (role === "user") sections.push("---");
      sections.push(role === "user" ? `## You · ${itemStamp(item)}` : "## Assistant");
    }
    sections.push(text);
    previousRole = role;
  }
  return `${sections.join("\n\n")}\n`;
}

function metadataLines(input: {
  readonly thread: ExportThread;
  readonly project: ExportProject | null;
  readonly transcript: OrchestrationV2ThreadTranscript;
  readonly exportedAt: string;
}): string[] {
  const { thread, project } = input;
  const repository = project?.repositoryIdentity;
  const pullRequests = thread.pullRequests.filter((link) => link.source !== "stack-dismissed");
  const lines = [
    `- Title: ${thread.title}`,
    `- Thread ID: ${thread.id}`,
    ...(project ? [`- Project: ${project.title} (${project.workspaceRoot})`] : []),
    ...(repository ? [`- Repository: ${repository.webUrl ?? repository.canonicalKey}`] : []),
    `- Branch: ${thread.branch ?? "none"}`,
    ...(thread.worktreePath ? [`- Worktree: ${thread.worktreePath}`] : []),
    `- Provider: ${thread.modelSelection.instanceId}, model ${thread.modelSelection.model}`,
    `- Created: ${stamp(thread.createdAt)}`,
    `- Last updated: ${stamp(input.transcript.updatedAt)}`,
    `- Exported: ${stamp(input.exportedAt)}`,
  ];
  if (pullRequests.length > 0) {
    lines.push("- Pull requests:");
    for (const link of pullRequests) {
      const state = link.snapshot?.state;
      lines.push(`  - ${link.url}${state ? ` (${state})` : ""}`);
    }
  }
  return lines;
}

function latestTodoList(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): TurnItemOf<"todo_list"> | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]?.item;
    if (item?.type === "todo_list") return item;
  }
  return null;
}

function todoLines(item: TurnItemOf<"todo_list">): string[] {
  const marks = { completed: "[x]", running: "[~]", pending: "[ ]" } as const;
  return [
    ...(item.explanation ? [item.explanation.trim(), ""] : []),
    ...item.steps.map((step) => `- ${marks[step.status]} ${step.text}`),
  ];
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(answerText).join(", ");
  return JSON.stringify(value) ?? "";
}

function unknownToText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

/** One Markdown block per timeline item, or null for items with no handoff value. */
function agentItemBlock(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `### User · ${itemStamp(item)}\n\n${messageText(item) || "(empty message)"}`;
    case "assistant_message": {
      const text = messageText(item);
      return text.length === 0 ? null : `### Assistant\n\n${text}`;
    }
    case "proposed_plan":
      return `### Proposed plan\n\n${item.markdown.trim()}`;
    case "todo_list":
      return `### To-do list update\n\n${todoLines(item).join("\n")}`;
    case "command_execution": {
      const exit = item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
      const output =
        item.output === undefined || item.output.trim().length === 0
          ? item.outputOmitted
            ? "\n\n(output not included)"
            : ""
          : `\n\n${fenced(truncate(item.output.trimEnd()))}`;
      return `- Command${exit}:\n\n${fenced(truncate(item.input), "sh")}${output}`;
    }
    case "file_change": {
      const counts =
        item.additions === undefined && item.deletions === undefined
          ? ""
          : ` (+${item.additions ?? 0} −${item.deletions ?? 0})`;
      const paths = item.changes?.map((change) => `${change.operation} ${change.path}`);
      return paths && paths.length > 0
        ? `- File change${counts}: ${paths.join(", ")}`
        : `- Edited \`${item.fileName}\`${counts}`;
    }
    case "file_search":
      return `- Searched files${item.pattern ? ` for \`${item.pattern}\`` : ""}`;
    case "web_search": {
      const urls = (item.results ?? []).flatMap((result) => (result.url ? [result.url] : []));
      const query = item.patterns?.join("; ");
      return `- Searched the web${query ? ` for "${query}"` : ""}${
        urls.length > 0 ? `: ${urls.slice(0, 5).join(", ")}` : ""
      }`;
    }
    case "dynamic_tool": {
      const name = item.toolName ?? item.title ?? "tool";
      const output =
        item.output === undefined ? "" : `\n\n${fenced(truncate(unknownToText(item.output)))}`;
      return `- Tool \`${name}\`:\n\n${fenced(truncate(unknownToText(item.input)), "json")}${output}`;
    }
    case "subagent": {
      const result = item.result ? `\n\nResult:\n\n${truncate(item.result.trim())}` : "";
      return `### Subagent (${item.driver})\n\nPrompt:\n\n${truncate(item.prompt.trim())}${result}`;
    }
    case "user_input_request": {
      const answers = item.questionAnswer?.answers ?? {};
      const lines = item.questions.map((question) => {
        const answer = answers[question.id];
        return `- ${question.question}\n  Answer: ${answer === undefined ? "(none)" : answerText(answer)}`;
      });
      return `### Agent asked the user\n\n${lines.join("\n")}`;
    }
    case "error":
      return `- Error (${item.failure.class}): ${item.failure.message}`;
    case "compaction":
      return item.summary ? `### Context compaction summary\n\n${item.summary.trim()}` : null;
    case "handoff":
      return `- Provider handoff to ${item.toProviderInstanceId}${item.toModel ? `, model ${item.toModel}` : ""}`;
    case "fork":
      return `- Forked here from thread ${
        item.source.type === "run" ? item.source.threadId : "another thread"
      }`;
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return `- ${item.message}`;
    default:
      return null;
  }
}

/**
 * Everything a receiving agent needs: where the work lives, the latest to-do
 * state, and the conversation with plans and tool activity in order.
 */
export function buildAgentThreadExport(input: {
  readonly thread: ExportThread;
  readonly project: ExportProject | null;
  readonly transcript: OrchestrationV2ThreadTranscript;
  readonly exportedAt: string;
}): string {
  const { transcript } = input;
  const todo = latestTodoList(transcript.items);
  const blocks = transcript.items.flatMap(({ item }) => agentItemBlock(item) ?? []);
  const sections = [
    `# Thread handoff: ${transcript.title}`,
    AGENT_EXPORT_PREAMBLE,
    "## Thread",
    metadataLines(input).join("\n"),
    ...(todo ? ["## Latest to-do list", todoLines(todo).join("\n")] : []),
    "## Conversation and activity",
    ...blocks,
  ];
  return `${sections.join("\n\n")}\n`;
}
