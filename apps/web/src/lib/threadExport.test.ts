import { describe, expect, it } from "vite-plus/test";

import {
  ChatAttachmentId,
  MessageId,
  PlanId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildAgentThreadExport,
  buildHumanThreadExport,
  threadExportFilename,
} from "./threadExport";

const threadId = ThreadId.make("thread-1");

function base(id: string, ordinal: number) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe("2026-10-28T09:15:00.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-28T09:15:00.000Z"),
  };
}

function prompt(id: string, ordinal: number, text: string): OrchestrationV2TurnItem {
  return {
    ...base(id, ordinal),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  };
}

function answer(id: string, ordinal: number, text: string): OrchestrationV2TurnItem {
  return {
    ...base(id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  };
}

function transcript(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadTranscript {
  return {
    threadId,
    title: "Fix login: bug/2",
    updatedAt: DateTime.makeUnsafe("2026-10-28T10:00:00.000Z"),
    items: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

const exportedAt = "2026-10-28T11:30:00.000Z";

describe("buildHumanThreadExport", () => {
  it("keeps only questions and answers and names attachments", () => {
    const withImage: OrchestrationV2TurnItem = {
      ...base("u1", 0),
      type: "user_message",
      messageId: MessageId.make("u1"),
      text: "Why does login fail?",
      attachments: [
        {
          type: "image",
          id: ChatAttachmentId.make("a1"),
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    };
    const markdown = buildHumanThreadExport({
      transcript: transcript([
        withImage,
        { ...base("c1", 1), type: "command_execution", input: "rg secret", output: "x" },
        { ...base("r1", 2), type: "reasoning", text: "private thought", streaming: false },
        answer("a1", 3, "The token expired."),
        answer("a2", 4, "I fixed the check."),
        prompt("u2", 5, "Thanks"),
      ]),
      exportedAt,
    });

    expect(markdown).toContain("[image: screenshot.png]");
    expect(markdown).not.toContain("rg secret");
    expect(markdown).not.toContain("private thought");
    // Two assistant messages in a row form one answer under one heading.
    expect(markdown.match(/## Assistant/g)).toHaveLength(1);
    expect(markdown.indexOf("The token expired.")).toBeLessThan(
      markdown.indexOf("I fixed the check."),
    );
    expect(markdown.match(/## You · 2026-10-28 09:15 UTC/g)).toHaveLength(2);
  });
});

describe("buildAgentThreadExport", () => {
  const thread = {
    id: threadId,
    title: "Fix login: bug/2",
    branch: "fix/login",
    worktreePath: "/work/login",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    createdAt: "2026-10-27T08:00:00.000Z",
    pullRequests: [],
  };
  const project = {
    title: "Web",
    workspaceRoot: "/work/web",
    repositoryIdentity: null,
  };

  it("adds metadata, the latest to-do list, and truncated tool activity", () => {
    const todo = (ordinal: number, status: "pending" | "completed"): OrchestrationV2TurnItem => ({
      ...base(`todo-${ordinal}`, ordinal),
      type: "todo_list",
      planId: PlanId.make("plan"),
      steps: [{ id: "s1", text: "Patch the token check", status }],
    });
    const markdown = buildAgentThreadExport({
      thread,
      project,
      transcript: transcript([
        prompt("u1", 0, "Fix login"),
        todo(1, "pending"),
        {
          ...base("c1", 2),
          type: "command_execution",
          input: "vp test run",
          output: "a".repeat(2500),
          exitCode: 1,
        },
        {
          ...base("p1", 3),
          type: "proposed_plan",
          planId: PlanId.make("plan"),
          markdown: "# Plan\n\n- Patch it",
          streaming: false,
        },
        todo(4, "completed"),
        answer("a1", 5, "Done."),
      ]),
      exportedAt,
    });

    expect(markdown).toContain("- Branch: fix/login");
    expect(markdown).toContain("- Provider: claude, model opus");
    expect(markdown).toContain("- Project: Web (/work/web)");
    const latestTodo = markdown.slice(
      markdown.indexOf("## Latest to-do list"),
      markdown.indexOf("## Conversation and activity"),
    );
    expect(latestTodo).toContain("- [x] Patch the token check");
    expect(markdown).toContain("Command (exit 1)");
    expect(markdown).toContain("[… 500 more characters]");
    expect(markdown).toContain("### Proposed plan\n\n# Plan");
  });

  it("fences output that contains backticks so the block cannot close early", () => {
    const markdown = buildAgentThreadExport({
      thread,
      project: null,
      transcript: transcript([
        {
          ...base("c1", 0),
          type: "command_execution",
          input: "cat README.md",
          output: "```js\nx\n```",
        },
      ]),
      exportedAt,
    });

    expect(markdown).toContain("````\n```js\nx\n```\n````");
  });
});

describe("threadExportFilename", () => {
  it("replaces unsafe characters and marks the agent file", () => {
    expect(threadExportFilename("Fix login: bug/2", "human")).toBe("Fix login_ bug_2.md");
    expect(threadExportFilename("Fix login: bug/2", "agent")).toBe("Fix login_ bug_2.agent.md");
  });
});
