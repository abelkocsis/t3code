import { describe, expect, it } from "@effect/vitest";

import {
  groupPromptsByWorkspace,
  isReportableWorkspace,
  parseCliPromptLine,
} from "./standupCliTranscripts.ts";

function line(record: unknown): string {
  return JSON.stringify(record);
}

describe("parseCliPromptLine", () => {
  it("reads a prompt written as typed content blocks", () => {
    const parsed = parseCliPromptLine(
      line({
        type: "user",
        cwd: "/repo",
        timestamp: "2026-09-15T08:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "fix the withdrawal bug" }] },
      }),
    );
    expect(parsed).toEqual({
      timestampMs: Date.parse("2026-09-15T08:00:00.000Z"),
      cwd: "/repo",
      text: "fix the withdrawal bug",
    });
  });

  it("reads a prompt written as a plain string", () => {
    expect(
      parseCliPromptLine(
        line({
          type: "user",
          cwd: "/repo",
          timestamp: "2026-09-15T08:00:00.000Z",
          message: { role: "user", content: "deploy to devnet" },
        }),
      )?.text,
    ).toBe("deploy to devnet");
  });

  it("drops a tool result the CLI wrote back as a user turn", () => {
    expect(
      parseCliPromptLine(
        line({
          type: "user",
          cwd: "/repo",
          timestamp: "2026-09-15T08:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "total 42" }],
          },
        }),
      ),
    ).toBeNull();
  });

  it("drops an injected reminder", () => {
    expect(
      parseCliPromptLine(
        line({
          type: "user",
          cwd: "/repo",
          timestamp: "2026-09-15T08:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "<system-reminder>hi</system-reminder>" }],
          },
        }),
      ),
    ).toBeNull();
  });

  it("drops assistant lines, meta lines and malformed lines", () => {
    expect(
      parseCliPromptLine(line({ type: "assistant", message: { content: "hello" } })),
    ).toBeNull();
    expect(
      parseCliPromptLine(
        line({
          type: "user",
          isMeta: true,
          timestamp: "2026-09-15T08:00:00.000Z",
          message: { role: "user", content: "meta" },
        }),
      ),
    ).toBeNull();
    expect(parseCliPromptLine('{"type":"user" broken')).toBeNull();
    expect(parseCliPromptLine("")).toBeNull();
  });
});

describe("groupPromptsByWorkspace", () => {
  it("groups by directory and puts the most recent directory first", () => {
    const grouped = groupPromptsByWorkspace(
      [
        { timestampMs: 10, cwd: "/a", text: "one" },
        { timestampMs: 30, cwd: "/b", text: "two" },
        { timestampMs: 20, cwd: "/a", text: "three" },
      ],
      { workspaces: 5, promptsPerWorkspace: 5 },
    );
    expect(grouped).toEqual([
      { workspace: "/b", prompts: ["two"] },
      { workspace: "/a", prompts: ["one", "three"] },
    ]);
  });

  it("applies both limits", () => {
    const grouped = groupPromptsByWorkspace(
      [
        { timestampMs: 1, cwd: "/a", text: "one" },
        { timestampMs: 2, cwd: "/a", text: "two" },
        { timestampMs: 3, cwd: "/b", text: "three" },
      ],
      { workspaces: 1, promptsPerWorkspace: 1 },
    );
    expect(grouped).toEqual([{ workspace: "/b", prompts: ["three"] }]);
  });
});

describe("isReportableWorkspace", () => {
  const worktreesDir = "/home/dev/.t3/worktrees";

  it("keeps a session the user ran in their own checkout", () => {
    expect(isReportableWorkspace({ cwd: "/home/dev/code/attestor", worktreesDir })).toBe(true);
  });

  it("drops T3 Code's own title directory", () => {
    expect(
      isReportableWorkspace({ cwd: "/var/folders/T/t3code-claude-title-3iUiKp", worktreesDir }),
    ).toBe(false);
  });

  it("drops a session inside a T3 Code worktree, which a thread already reports", () => {
    expect(
      isReportableWorkspace({
        cwd: "/home/dev/.t3/worktrees/attestor/t3code-5e948e28",
        worktreesDir,
      }),
    ).toBe(false);
  });

  it("reads a Windows path with the same rules", () => {
    expect(
      isReportableWorkspace({
        cwd: "C:\\Users\\dev\\.t3\\worktrees\\attestor",
        worktreesDir: "C:\\Users\\dev\\.t3\\worktrees",
      }),
    ).toBe(false);
  });
});
