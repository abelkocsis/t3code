import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeProjectDirectoryName, workspaceStateLinks } from "./providerWorkspaceState.ts";

const claude = ProviderDriverKind.make("claudeAgent");

describe("claudeProjectDirectoryName", () => {
  it("names a project directory the way Claude Code does", () => {
    expect(claudeProjectDirectoryName("/Users/me/BitSafe/code/t3code")).toBe(
      "-Users-me-BitSafe-code-t3code",
    );
  });

  it("folds a dot, so a hidden directory reads as Claude Code writes it", () => {
    // Verified against a real directory: `/Users/me/code/app/.claude/worktrees/fix`
    // is stored as `-Users-me-code-app--claude-worktrees-fix`.
    expect(claudeProjectDirectoryName("/Users/me/code/app/.claude/worktrees/fix")).toBe(
      "-Users-me-code-app--claude-worktrees-fix",
    );
  });

  it("folds a Windows separator too", () => {
    expect(claudeProjectDirectoryName("C:\\Users\\me\\code\\app")).toBe("C:-Users-me-code-app");
  });

  it("gives two paths two names, which is the whole problem", () => {
    expect(claudeProjectDirectoryName("/a/app")).not.toBe(claudeProjectDirectoryName("/b/app"));
  });
});

describe("workspaceStateLinks", () => {
  it("carries Claude Code's memory from the project into the worktree", () => {
    expect(
      workspaceStateLinks({
        driver: claude,
        projectPath: "/Users/me/code/app",
        worktreePath: "/Users/me/.t3/worktrees/app/fix",
      }),
    ).toEqual([
      {
        driver: claude,
        label: "memory",
        sourceSegments: ["projects", "-Users-me-code-app", "memory"],
        destinationSegments: ["projects", "-Users-me--t3-worktrees-app-fix", "memory"],
      },
    ]);
  });

  it("carries nothing when the thread runs in the project itself", () => {
    expect(
      workspaceStateLinks({
        driver: claude,
        projectPath: "/Users/me/code/app",
        worktreePath: "/Users/me/code/app",
      }),
    ).toEqual([]);
  });

  it("leaves Codex alone, since its memories live in one database per home", () => {
    expect(
      workspaceStateLinks({
        driver: ProviderDriverKind.make("codex"),
        projectPath: "/Users/me/code/app",
        worktreePath: "/Users/me/.t3/worktrees/app/fix",
      }),
    ).toEqual([]);
  });

  it("leaves a driver nobody has checked alone rather than guessing at its layout", () => {
    for (const name of ["cursor", "grok", "opencode", "antigravity", "something-forked"]) {
      expect(
        workspaceStateLinks({
          driver: ProviderDriverKind.make(name),
          projectPath: "/Users/me/code/app",
          worktreePath: "/Users/me/.t3/worktrees/app/fix",
        }),
      ).toEqual([]);
    }
  });
});
