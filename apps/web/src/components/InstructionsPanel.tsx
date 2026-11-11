import { useAtomValue } from "@effect/atom-react";
import {
  agentInstructionsFileName,
  type AgentInstructionsGlobalFile,
  type EnvironmentId,
  type ProjectReadFileResult,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

type InstructionsScope = "agents" | "claude" | "global";

interface LoadedFile {
  readonly path: string;
  readonly contents: string;
  readonly exists: boolean;
}

type GlobalFileResult = AsyncResult.AsyncResult<AgentInstructionsGlobalFile, unknown>;
type RepoFileResult = AsyncResult.AsyncResult<ProjectReadFileResult, unknown>;

const NO_GLOBAL_FILE = Atom.make((): GlobalFileResult => AsyncResult.initial()).pipe(
  Atom.withLabel("web-instructions:no-global-file"),
);
const NO_REPO_FILE = Atom.make((): RepoFileResult => AsyncResult.initial()).pipe(
  Atom.withLabel("web-instructions:no-repo-file"),
);

export interface InstructionsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
  /** The thread's checkout: its worktree when it has one, else the project root. */
  readonly workspaceRoot: string | null;
  /** Set when the checkout is a worktree, so the user sees whose copy they edit. */
  readonly worktreeBranch: string | null;
}

/**
 * The instructions file the thread's provider reads, in this checkout or in the provider's
 * home. Saving is explicit: these files steer every later turn, so a half-typed edit must not
 * reach the agent.
 */
export function InstructionsPanel(props: InstructionsPanelProps) {
  const { environmentId, instanceId, driver, workspaceRoot, worktreeBranch } = props;
  const globalFileName = driver === null ? null : agentInstructionsFileName(driver);
  const [selectedScope, setScope] = useState<InstructionsScope>("agents");
  const claudeResult = useAtomValue<RepoFileResult>(
    workspaceRoot === null
      ? NO_REPO_FILE
      : projectEnvironment.readFile({
          environmentId,
          input: { cwd: workspaceRoot, relativePath: "CLAUDE.md", allowMissing: true },
        }),
  );
  const hasClaudeFile = Option.getOrNull(AsyncResult.value(claudeResult))?.exists === true;
  const scope = selectedScope === "claude" && !hasClaudeFile ? "agents" : selectedScope;
  const [drafts, setDrafts] = useState<Record<InstructionsScope, string | null>>({
    agents: null,
    claude: null,
    global: null,
  });
  const fileName =
    scope === "global" ? globalFileName : scope === "agents" ? "AGENTS.md" : "CLAUDE.md";
  const [creating, setCreating] = useState<Record<InstructionsScope, boolean>>({
    agents: false,
    claude: false,
    global: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const globalInput =
    instanceId === null ? null : { environmentId, input: { instanceId } as const };
  const repoInput =
    workspaceRoot === null || fileName === null
      ? null
      : {
          environmentId,
          input: { cwd: workspaceRoot, relativePath: fileName, allowMissing: true },
        };

  const globalResult = useAtomValue<GlobalFileResult>(
    scope === "global" && globalInput !== null && fileName !== null
      ? serverEnvironment.globalAgentInstructions(globalInput)
      : NO_GLOBAL_FILE,
  );
  const repoResult = useAtomValue<RepoFileResult>(
    scope !== "global" && repoInput !== null
      ? projectEnvironment.readFile(repoInput)
      : NO_REPO_FILE,
  );
  const result = scope === "global" ? globalResult : repoResult;
  const storedGlobal = Option.getOrNull(AsyncResult.value(globalResult));
  const storedRepo = Option.getOrNull(AsyncResult.value(repoResult));
  const file: LoadedFile | null =
    scope === "global"
      ? storedGlobal
      : storedRepo === null
        ? null
        : {
            path: `${workspaceRoot}/${fileName}`,
            contents: storedRepo.contents,
            exists: storedRepo.exists !== false,
          };

  const refreshRepo = useAtomQueryRunner(projectEnvironment.readFile, {
    label: "web-instructions:refresh-repo",
    refresh: true,
    reportFailure: false,
  });
  const refreshGlobal = useAtomQueryRunner(serverEnvironment.globalAgentInstructions, {
    label: "web-instructions:refresh-global",
    refresh: true,
    reportFailure: false,
  });
  const writeRepo = useAtomCommand(projectEnvironment.writeFile, {
    label: "web-instructions:write-repo",
    reportFailure: false,
  });
  const writeGlobal = useAtomCommand(serverEnvironment.writeGlobalAgentInstructions, {
    label: "web-instructions:write-global",
    reportFailure: false,
  });

  if (fileName === null || instanceId === null || globalInput === null) {
    return (
      <p className="p-3 text-muted-foreground text-sm">
        Instructions can be edited for Claude and Codex threads. This thread uses another provider.
      </p>
    );
  }

  const draft = drafts[scope];
  const setDraft = (next: string | null) => setDrafts((current) => ({ ...current, [scope]: next }));

  const reload = () => {
    setSaveError(null);
    setDraft(null);
    if (scope === "global") void refreshGlobal(globalInput);
    else if (repoInput !== null) void refreshRepo(repoInput);
  };

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (scope === "global") {
        const written = await writeGlobal({
          environmentId,
          input: { instanceId, contents: draft },
        });
        if (written._tag !== "Success") {
          setSaveError("The global file could not be saved.");
          return;
        }
        await refreshGlobal(globalInput);
      } else {
        if (repoInput === null) return;
        const written = await writeRepo({
          environmentId,
          input: { cwd: repoInput.input.cwd, relativePath: fileName, contents: draft },
        });
        if (written._tag !== "Success") {
          setSaveError(`${fileName} could not be saved.`);
          return;
        }
        await refreshRepo(repoInput);
      }
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const fixClaude = async () => {
    if (repoInput === null || file === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const agents = await refreshRepo({
        environmentId,
        input: { cwd: repoInput.input.cwd, relativePath: "AGENTS.md", allowMissing: true },
      });
      if (agents._tag !== "Success") throw new Error("AGENTS.md could not be read.");
      const extra = (draft ?? file.contents)
        .split("\n")
        .filter((line) => line.trim() !== "@AGENTS.md")
        .join("\n")
        .trim();
      if (extra) {
        const written = await writeRepo({
          environmentId,
          input: {
            cwd: repoInput.input.cwd,
            relativePath: "AGENTS.md",
            contents: [agents.value.contents.trim(), extra].filter(Boolean).join("\n\n") + "\n",
          },
        });
        if (written._tag !== "Success")
          throw new Error("AGENTS.md could not be saved. CLAUDE.md was left unchanged.");
      }
      const written = await writeRepo({
        environmentId,
        input: { cwd: repoInput.input.cwd, relativePath: "CLAUDE.md", contents: "@AGENTS.md\n" },
      });
      if (written._tag !== "Success") throw new Error("CLAUDE.md could not be saved.");
      setDraft(null);
      await refreshRepo(repoInput);
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "The instructions could not be updated.",
      );
    } finally {
      setSaving(false);
    }
  };

  const location =
    scope === "global"
      ? "Every thread of this provider on this server."
      : worktreeBranch !== null
        ? `This worktree only (${worktreeBranch}).`
        : scope === "agents"
          ? "This repository, for all agents"
          : "This repository, for Claude agents only";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {(["agents", ...(hasClaudeFile ? ["claude" as const] : [])] as const).map((tab) => (
            <Button
              key={tab}
              size="xs"
              variant={scope === tab ? "secondary" : "ghost"}
              aria-pressed={scope === tab}
              disabled={saving}
              onClick={() => setScope(tab)}
            >
              This repo - {tab === "agents" ? "AGENTS.md" : "CLAUDE.md"}
            </Button>
          ))}
          <Button
            size="xs"
            variant={scope === "global" ? "secondary" : "ghost"}
            aria-pressed={scope === "global"}
            disabled={saving}
            onClick={() => setScope("global")}
          >
            Global
          </Button>
          <span className="min-w-0 flex-1" />
          <Button size="xs" variant="ghost" disabled={saving} onClick={reload}>
            Reload
          </Button>
          <Button size="xs" disabled={draft === null || saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
        <p className="min-w-0 truncate px-1 text-muted-foreground text-xs">
          <span className="font-mono">
            {scope === "global" ? (file?.path ?? fileName) : fileName}
          </span>
          {" · "}
          {location}
        </p>
      </div>
      {scope === "claude" &&
      file?.exists &&
      file.contents.trim() !== "@AGENTS.md" &&
      file.contents.trim() !== "" ? (
        <div className="px-3 py-2 text-sm text-caution" role="alert">
          <p>
            ⚠ Different agents might read different instructions. CLAUDE.md should contain only
            @AGENTS.md.
          </p>
          <p>The fix moves additional instructions into AGENTS.md and makes CLAUDE.md import it.</p>
          <Button
            size="xs"
            variant="outline"
            disabled={saving || draft !== null}
            onClick={() => void fixClaude()}
          >
            Fix instructions
          </Button>
        </div>
      ) : null}
      {saveError !== null ? (
        <p className="shrink-0 px-3 py-2 text-destructive text-sm">{saveError}</p>
      ) : null}
      {result._tag === "Failure" ? (
        <p className="px-3 py-2 text-destructive text-sm">{fileName} could not be read.</p>
      ) : file === null ? (
        <p className="px-3 py-2 text-muted-foreground text-sm">Loading…</p>
      ) : !file.contents.trim() && draft === null && !creating[scope] ? (
        <div className="p-3 text-sm">
          <p>{fileName} is empty or does not exist.</p>
          <Button
            size="xs"
            onClick={() => {
              setCreating((current) => ({ ...current, [scope]: true }));
              setDraft(scope === "claude" ? "@AGENTS.md\n" : "");
            }}
          >
            Create {fileName}
          </Button>
        </div>
      ) : (
        // A plain textarea: the shared one stops growing at a few lines, and these files are
        // hand-wrapped Markdown that reads best unwrapped, in the editor's monospace face.
        <textarea
          className="min-h-0 w-full flex-1 resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-foreground text-xs leading-5 outline-none placeholder:text-muted-foreground"
          wrap="off"
          value={draft ?? file.contents}
          spellCheck={false}
          aria-label={`${fileName}, ${scope === "global" ? "global" : "this repo"}`}
          placeholder={
            file.exists ? undefined : `No ${fileName} yet. Write one and save to create it.`
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
      )}
    </div>
  );
}
