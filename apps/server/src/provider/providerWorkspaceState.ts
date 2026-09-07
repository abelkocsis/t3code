import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * One directory of provider state that should follow the work into a new
 * workspace.
 *
 * Both sides are segments below the provider's config directory rather than
 * whole paths, so the caller joins them with the platform's own separator.
 */
export interface WorkspaceStateLink {
  readonly driver: ProviderDriverKind;
  /** Short name for logs, since a path says nothing about what was carried. */
  readonly label: string;
  /** What the provider already holds for the project's own checkout. */
  readonly sourceSegments: ReadonlyArray<string>;
  /** Where the provider will look once it runs in the new workspace. */
  readonly destinationSegments: ReadonlyArray<string>;
}

/**
 * Claude Code names a project directory after the absolute path it ran in,
 * with every separator and dot replaced by `-`: `/Users/me/code/app` becomes
 * `-Users-me-code-app`. A worktree is a different path, so it is a different
 * directory, which is why a fresh workspace starts with no memory.
 *
 * This mirrors a convention Claude Code owns rather than one it promises, so
 * callers treat a miss as "nothing to carry" rather than an error. A link
 * written under a name Claude Code no longer uses is orphaned and inert.
 */
export function claudeProjectDirectoryName(absolutePath: string): string {
  return absolutePath.replaceAll(/[/\\.]/gu, "-");
}

export interface WorkspaceStateInput {
  readonly driver: ProviderDriverKind;
  /** The project's checkout, which holds the state worth carrying. */
  readonly projectPath: string;
  /** The new workspace, which has none of it yet. */
  readonly worktreePath: string;
}

/**
 * What a driver keeps per project path, and therefore loses when the path
 * changes.
 *
 * Only Claude Code is carried. It keys durable project state to a directory
 * named after the path, so a worktree cannot see it. Codex keeps its memories
 * in a SQLite database inside its own home, which one workspace does not hide
 * from another. Cursor, Grok, OpenCode and Antigravity are left alone because
 * nothing has been confirmed about where they keep project state — that is an
 * open question, not a finding that they are unaffected.
 */
export function workspaceStateLinks(input: WorkspaceStateInput): ReadonlyArray<WorkspaceStateLink> {
  const { driver, projectPath, worktreePath } = input;
  // A local thread runs in the project itself, so there is nothing to carry.
  if (driver !== "claudeAgent" || projectPath === worktreePath) return [];
  return [
    {
      driver,
      label: "memory",
      sourceSegments: ["projects", claudeProjectDirectoryName(projectPath), "memory"],
      destinationSegments: ["projects", claudeProjectDirectoryName(worktreePath), "memory"],
    },
  ];
}
