# Agent instructions

**Agent instructions** shows the instructions file the thread's agent reads, and lets you edit
it. Open it from the right panel's **+** menu, or run **Agent instructions** from the command
palette.

The file follows the thread's provider: Claude reads `CLAUDE.md`, Codex reads `AGENTS.md`.
Other providers are not supported yet.

- **This repo** is the file in the thread's checkout. In a worktree thread that is the
  worktree's copy, so the change belongs to that branch until you commit it.
- **Global** is the file in the provider's home, such as `~/.claude/CLAUDE.md` or
  `~/.codex/AGENTS.md`, on the machine the server runs on. It applies to every thread of that
  provider there. A custom home in the provider's settings is respected.

Nothing is written until you press **Save** or ⌘S. **Reload** drops your edit and reads the
file again. Changing the global file needs permission to manage providers on that server.
