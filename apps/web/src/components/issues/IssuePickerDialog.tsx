import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
} from "@t3tools/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
} from "@t3tools/contracts";
import { CircleDotIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  ensureBrowseDirectoryPath,
  findProjectByPath,
  inferProjectTitleFromPath,
} from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildIssueSections,
  composeIssueSeedMessage,
  defaultIssueInstructions,
  isBareIssueNumber,
  issueKey,
  parseIssueLookup,
  selectedRepository,
  selectionWouldReset,
  toggleIssueSelection,
} from "./issuePicker.logic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** How long the field stays quiet before a search runs. */
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_ROWS = 40;

type Phase = "idle" | "searching" | "loading" | "starting";
/** `pick` chooses the issues; `compose` edits the first message built from them. */
type Step = "pick" | "compose";

/**
 * Pick GitHub issues and open a thread on them.
 *
 * The search spans every repository the account can read, because a user who
 * starts from an issue often has no project for it yet. The chosen issue names
 * the repository; the project is reused when one already sits at the clone
 * path, and cloned when it does not.
 */
export function IssuePickerDialog({
  open,
  onOpenChange,
  environmentId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const searchIssues = useAtomQueryRunner(sourceControlEnvironment.issues, {
    reportFailure: false,
  });
  const loadIssueDetails = useAtomQueryRunner(sourceControlEnvironment.issueDetails, {
    reportFailure: false,
  });
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [assignedToViewer, setAssignedToViewer] = useState(true);
  const [freshWorkspace, setFreshWorkspace] = useState(true);
  const [issues, setIssues] = useState<ReadonlyArray<SourceControlIssueSummary>>([]);
  const [selected, setSelected] = useState<ReadonlyArray<SourceControlIssueSummary>>([]);
  const [truncated, setTruncated] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  // The message is two parts. `instructions` is the user's own text: null
  // until they touch it, so the default can follow the issue count. `sections`
  // is rebuilt from the selection every time the compose step opens.
  const [instructions, setInstructions] = useState<string | null>(null);
  const [sections, setSections] = useState("");
  const [details, setDetails] = useState<ReadonlyArray<SourceControlIssueDetail>>([]);
  // Only the newest search may write the list: a slow first request must not
  // overwrite the rows a later, faster one already showed.
  const searchGeneration = useRef(0);

  const environment = environments.find((each) => each.environmentId === environmentId);
  const baseDirectory = environment?.serverConfig?.settings?.addProjectBaseDirectory?.trim() ?? "";

  const repository = selectedRepository(selected);
  // A bare number is the only entry the locked repository changes the meaning
  // of, so it is the only case that lets a selection change rerun the search.
  const lockedForLookup = isBareIssueNumber(query) ? repository : null;

  const runSearch = useCallback(
    async (text: string, filterToViewer: boolean, lockedRepository: string | null) => {
      const generation = ++searchGeneration.current;
      setPhase("searching");
      const lookup = parseIssueLookup(text, lockedRepository);
      if (lookup.kind === "issue") {
        const result = await loadIssueDetails({
          environmentId,
          input: {
            provider: "github",
            issues: [{ repository: lookup.repository, number: lookup.number }],
          },
        });
        if (generation !== searchGeneration.current) return;
        setPhase("idle");
        setTruncated(false);
        if (result._tag === "Failure") {
          setIssues([]);
          setFailure(`No issue #${lookup.number} in ${lookup.repository}, or you cannot read it.`);
          return;
        }
        setFailure(null);
        setIssues(result.value.issues);
        return;
      }
      const result = await searchIssues({
        environmentId,
        input: {
          provider: "github",
          query: lookup.query,
          assignedToViewer: filterToViewer,
          repository: lookup.repository,
          limit: SEARCH_ROWS,
        },
      });
      if (generation !== searchGeneration.current) return;
      setPhase("idle");
      if (result._tag === "Failure") {
        setIssues([]);
        setTruncated(false);
        setFailure(errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      setFailure(null);
      setIssues(result.value.issues);
      setTruncated(result.value.truncated);
    },
    [environmentId, loadIssueDetails, searchIssues],
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void runSearch(query, assignedToViewer, lockedForLookup);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [assignedToViewer, lockedForLookup, open, query, runSearch]);

  // Reset on the close itself rather than in an effect watching `open`: the
  // event is what changed, and a reopened picker starts clean rather than
  // showing yesterday's search.
  const close = useCallback(() => {
    searchGeneration.current += 1;
    setStep("pick");
    setQuery("");
    setIssues([]);
    setSelected([]);
    setTruncated(false);
    setFailure(null);
    setPhase("idle");
    setInstructions(null);
    setSections("");
    setDetails([]);
    onOpenChange(false);
  }, [onOpenChange]);

  const selectedKeys = useMemo(() => new Set(selected.map(issueKey)), [selected]);

  const fail = (title: string, description: string) => {
    setPhase("idle");
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  };

  /** Read the selected issues in full and move on to the message. */
  const compose = async () => {
    if (selected.length === 0 || phase === "loading" || phase === "starting") return;
    setPhase("loading");
    const result = await loadIssueDetails({
      environmentId,
      input: {
        provider: "github",
        issues: selected.map((issue) => ({ repository: issue.repository, number: issue.number })),
      },
    });
    if (result._tag === "Failure") {
      fail("Could not read the issues", errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    setPhase("idle");
    setDetails(result.value.issues);
    setSections(buildIssueSections(result.value.issues));
    setStep("compose");
  };

  const instructionsText = instructions ?? defaultIssueInstructions(details.length);

  const start = async () => {
    if (details.length === 0 || repository === null || phase === "starting") return;
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      fail(
        "Environment unavailable",
        `${environment?.label ?? "That environment"} is not connected.`,
      );
      return;
    }
    setPhase("starting");

    const environmentProjects = projects.filter(
      (project) => project.environmentId === environmentId,
    );
    const destinationPath = getCloneDestinationPath(
      ensureBrowseDirectoryPath(baseDirectory.length > 0 ? baseDirectory : "~/"),
      getCloneDirectoryName(repository),
    );
    const existing = findProjectByPath(environmentProjects, destinationPath);

    let projectId = existing?.id ?? null;
    if (projectId === null) {
      const lookup = await lookupRepository({
        environmentId,
        input: { provider: "github", repository },
      });
      if (lookup._tag === "Failure") {
        fail("Repository lookup failed", errorMessage(squashAtomCommandFailure(lookup)));
        return;
      }
      const cloned = await cloneRepository({
        environmentId,
        input: {
          remoteUrl: getDefaultCloneUrl(lookup.value),
          destinationPath,
        },
      });
      if (cloned._tag === "Failure") {
        fail("Clone failed", errorMessage(squashAtomCommandFailure(cloned)));
        return;
      }
      const created = newProjectId();
      const createResult = await createProject({
        environmentId,
        input: {
          projectId: created,
          title: inferProjectTitleFromPath(cloned.value.cwd),
          workspaceRoot: cloned.value.cwd,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (createResult._tag === "Failure") {
        fail("Could not add the project", errorMessage(squashAtomCommandFailure(createResult)));
        return;
      }
      projectId = created;
    }

    const thread = await handleNewThread(scopeProjectRef(environmentId, projectId), {
      envMode: freshWorkspace ? "worktree" : "local",
    });
    if (thread === null) {
      fail("Could not open a thread", "The project is there, but the thread could not be started.");
      return;
    }
    useComposerDraftStore
      .getState()
      .setPrompt(thread.draftId, composeIssueSeedMessage(instructionsText, sections));
    close();
  };

  const startLabel = details.length <= 1 ? "Start work" : `Start work on ${details.length} issues`;
  const nextLabel = selected.length <= 1 ? "Next" : `Next with ${selected.length} issues`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start from a GitHub issue</DialogTitle>
          <DialogDescription>
            {step === "compose"
              ? "This is the thread's first message. Edit it as you like; Start work puts it in the composer."
              : repository === null
                ? "Search every repository you can read, or paste an issue link. Picking an issue locks the list to its repository."
                : `Picking more issues from ${repository}. A different repository starts the selection again.`}
          </DialogDescription>
        </DialogHeader>
        {step === "pick" ? (
          <DialogPanel className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  className="ps-8"
                  placeholder="Search open issues, or paste a link, owner/repo or owner/repo#123"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
              </div>
              <Label className="flex shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
                <Switch
                  checked={assignedToViewer}
                  onCheckedChange={(checked) => setAssignedToViewer(Boolean(checked))}
                  aria-label="Only issues assigned to me"
                />
                Assigned to me
              </Label>
            </div>

            <div className="min-h-64 max-h-80 overflow-y-auto rounded-md border border-border/60">
              {failure !== null ? (
                <p className="p-4 text-sm text-muted-foreground">{failure}</p>
              ) : issues.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {phase === "searching" ? "Searching…" : "No open issues match."}
                </p>
              ) : (
                <ul>
                  {issues.map((issue) => (
                    <IssueRow
                      key={issueKey(issue)}
                      issue={issue}
                      checked={selectedKeys.has(issueKey(issue))}
                      resets={selectionWouldReset(selected, issue)}
                      onToggle={() =>
                        setSelected((current) => toggleIssueSelection(current, issue))
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing the {SEARCH_ROWS} most recently updated. Narrow the search, or type
                owner/repo to search one repository.
              </p>
            ) : null}
          </DialogPanel>
        ) : (
          <DialogPanel className="flex flex-col gap-3">
            <Label className="flex flex-col gap-1.5 text-sm font-normal">
              <span className="flex flex-col gap-0.5">
                <span>Instructions</span>
                <span className="text-xs text-muted-foreground">
                  Your own text. It stays as you wrote it when the issues change.
                </span>
              </span>
              <Textarea
                value={instructionsText}
                onChange={(event) => setInstructions(event.target.value)}
                style={{ maxHeight: "12rem" }}
              />
            </Label>
            <Label className="flex flex-col gap-1.5 text-sm font-normal">
              <span className="flex flex-col gap-0.5">
                <span>Issues</span>
                <span className="text-xs text-muted-foreground">
                  Filled in from the selected issues. Rebuilt whenever the selection changes.
                </span>
              </span>
              <Textarea
                value={sections}
                onChange={(event) => setSections(event.target.value)}
                style={{ maxHeight: "16rem" }}
              />
            </Label>

            <Label className="flex items-start gap-2.5 text-sm font-normal">
              <Checkbox
                checked={freshWorkspace}
                onCheckedChange={(checked) => setFreshWorkspace(Boolean(checked))}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span>Work in a fresh workspace</span>
                <span className="text-xs text-muted-foreground">
                  A separate checkout, so the work never touches your own copy of the repository.
                </span>
              </span>
            </Label>
          </DialogPanel>
        )}
        <DialogFooter>
          {step === "pick" ? (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={() => void compose()}
                disabled={selected.length === 0 || phase === "loading"}
              >
                {phase === "loading" ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden />
                ) : null}
                {nextLabel}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setStep("pick")}
                disabled={phase === "starting"}
              >
                Back
              </Button>
              <Button onClick={() => void start()} disabled={phase === "starting"}>
                {phase === "starting" ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden />
                ) : null}
                {startLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function IssueRow({
  issue,
  checked,
  resets,
  onToggle,
}: {
  readonly issue: SourceControlIssueSummary;
  readonly checked: boolean;
  /** True when picking this row would clear a selection in another repository. */
  readonly resets: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted/50 data-[selected=true]:bg-muted/70"
        data-selected={checked}
      >
        <Checkbox checked={checked} className="pointer-events-none mt-1" tabIndex={-1} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <CircleDotIcon
              className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground"
              aria-hidden
            />
            <span className="truncate text-sm font-medium">{issue.title}</span>
            <span className="ms-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {formatRelativeTimeLabel(issue.updatedAt)}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="truncate">
              {issue.repository}#{issue.number}
            </span>
            {issue.state === "closed" ? <span>Closed</span> : null}
            {issue.labels.slice(0, 4).map((label) => (
              <IssueLabel key={label.name} name={label.name} color={label.color} />
            ))}
            {issue.commentCount > 0 ? <span>{issue.commentCount} comments</span> : null}
            {resets ? <span className="text-warning">Replaces the current selection</span> : null}
          </span>
          {issue.summary.length > 0 ? (
            <span className="line-clamp-1 text-[11px] text-secondary-label">{issue.summary}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** GitHub reports six hex digits without the hash; anything else falls back to the border. */
function IssueLabel({ name, color }: { readonly name: string; readonly color: string }) {
  const usable = /^[0-9a-fA-F]{6}$/.test(color);
  return (
    <span
      className="rounded-full border px-1.5 py-px"
      style={
        usable
          ? { borderColor: `#${color}`, color: `#${color}` }
          : { borderColor: "var(--color-border)" }
      }
    >
      {name}
    </span>
  );
}
