import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getAddProjectInitialQuery,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
} from "@t3tools/client-runtime/operations/projects";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { CircleDotIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { newProjectId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, waitForProject } from "../../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  projectsForRepository,
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
const GITHUB = SourceControlProviderKind.make("github");

/** The workspace choice that clones the repository again instead of reusing a project. */
const CLONE_CHOICE = "clone";
type WorkspaceChoice = ProjectId | typeof CLONE_CHOICE;

type Phase = "idle" | "searching" | "loading" | "starting";
/** `pick` chooses the issues; `compose` edits the first message built from them. */
type Step = "pick" | "compose";

/**
 * Pick GitHub issues and open a thread on them.
 *
 * The search spans every repository the account can read, because a user who
 * starts from an issue often has no project for it yet. The chosen issue names
 * the repository; a project whose git remote names that repository is reused,
 * and the repository is cloned when there is none.
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
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [assignedToViewer, setAssignedToViewer] = useState(true);
  const [freshWorkspace, setFreshWorkspace] = useState(true);
  // null follows the repository match; a value is the user's own pick.
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceChoice | null>(null);
  // null follows the project default; a value is the user's own pick.
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
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
  const cloneTracking =
    environment?.serverConfig?.environment.capabilities.projectCloneTracking === true;

  const repository = selectedRepository(selected);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const repositoryProjects = projectsForRepository(environmentProjects, repository);
  // The first match is the default. A pick only holds while it still names a
  // project of the selected repository, so changing the selection re-defaults
  // rather than starting work in the repository the user left behind.
  const chosenProject = repositoryProjects.find((project) => project.id === workspaceChoice);
  const activeChoice: WorkspaceChoice =
    workspaceChoice === CLONE_CHOICE
      ? CLONE_CHOICE
      : (chosenProject?.id ?? repositoryProjects[0]?.id ?? CLONE_CHOICE);
  const activeProject =
    activeChoice === CLONE_CHOICE
      ? null
      : (repositoryProjects.find((project) => project.id === activeChoice) ?? null);
  const workspaceItems: ReadonlyArray<{ readonly value: WorkspaceChoice; readonly label: string }> =
    [
      ...repositoryProjects.map((project) => ({ value: project.id, label: project.title })),
      { value: CLONE_CHOICE, label: "Clone a fresh copy" },
    ];
  // A bare number is the only entry the locked repository changes the meaning
  // of, so it is the only case that lets a selection change rerun the search.
  const lockedForLookup = isBareIssueNumber(query) ? repository : null;

  const runSearch = async (
    text: string,
    filterToViewer: boolean,
    lockedRepository: string | null,
  ) => {
    const generation = ++searchGeneration.current;
    setPhase("searching");
    const lookup = parseIssueLookup(text, lockedRepository);
    if (lookup.kind === "issue") {
      const result = await loadIssueDetails({
        environmentId,
        input: {
          provider: GITHUB,
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
        provider: GITHUB,
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
  };

  // The debounce reruns on the three inputs alone. The search closure changes
  // every render, so the effect reads the latest one through a ref rather than
  // listing it and restarting the timer on each keystroke's re-render.
  const runSearchRef = useRef(runSearch);
  useEffect(() => {
    runSearchRef.current = runSearch;
  });
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void runSearchRef.current(query, assignedToViewer, lockedForLookup);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [assignedToViewer, lockedForLookup, open, query]);

  // Reset on the close itself rather than in an effect watching `open`: the
  // event is what changed, and a reopened picker starts clean rather than
  // showing yesterday's search.
  const close = () => {
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
    setWorkspaceChoice(null);
    setModelSelection(null);
    onOpenChange(false);
  };

  const selectedKeys = new Set(selected.map(issueKey));

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
        provider: GITHUB,
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

  /** Clone the repository into the default project folder and return the new project. */
  const cloneIntoProject = async (): Promise<ProjectId | null> => {
    if (repository === null) return null;
    const destinationPath = getCloneDestinationPath(
      getAddProjectInitialQuery(baseDirectory),
      getCloneDirectoryName(repository),
    );
    const lookup = await lookupRepository({
      environmentId,
      input: { provider: GITHUB, repository },
    });
    if (lookup._tag === "Failure") {
      fail("Repository lookup failed", errorMessage(squashAtomCommandFailure(lookup)));
      return null;
    }
    const remoteUrl = getDefaultCloneUrl(lookup.value);
    const projectId = newProjectId();
    if (cloneTracking) {
      // The project exists at once and the clone runs in the background; the
      // thread starts in it and waits for the checkout like any other.
      const started = await startProjectClone({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(destinationPath),
          createdAt: new Date().toISOString(),
          remoteUrl,
          destinationPath,
        },
      });
      if (started._tag === "Failure") {
        fail("Clone failed", errorMessage(squashAtomCommandFailure(started)));
        return null;
      }
      await waitForProject(scopeProjectRef(environmentId, projectId), 3_000).catch(() => null);
      return projectId;
    }
    // Older servers only offer the blocking clone, so the project is added after it.
    const cloned = await cloneRepository({
      environmentId,
      input: { remoteUrl, destinationPath },
    });
    if (cloned._tag === "Failure") {
      fail("Clone failed", errorMessage(squashAtomCommandFailure(cloned)));
      return null;
    }
    const created = await createProject({
      environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(cloned.value.cwd),
        workspaceRoot: cloned.value.cwd,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    if (created._tag === "Failure") {
      fail("Could not add the project", errorMessage(squashAtomCommandFailure(created)));
      return null;
    }
    return projectId;
  };

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

    const projectId = activeChoice === CLONE_CHOICE ? await cloneIntoProject() : activeChoice;
    if (projectId === null) return;

    const thread = await handleNewThread(scopeProjectRef(environmentId, projectId), {
      envMode: freshWorkspace ? "worktree" : "local",
    });
    if (thread === null) {
      fail("Could not open a thread", "The project is there, but the thread could not be started.");
      return;
    }
    const draftStore = useComposerDraftStore.getState();
    draftStore.setPrompt(thread.draftId, composeIssueSeedMessage(instructionsText, sections));
    if (modelSelection !== null) {
      draftStore.setModelSelection(thread.draftId, modelSelection, {
        explicit: true,
        replaceOptions: true,
      });
    }
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
      <DialogPopup className="sm:max-w-2xl">
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
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <InputGroup className="flex-1">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    placeholder="Search open issues, or paste a link, owner/repo or owner/repo#123"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    autoFocus
                  />
                </InputGroup>
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={assignedToViewer}
                    onCheckedChange={(checked) => setAssignedToViewer(Boolean(checked))}
                    aria-label="Only issues assigned to me"
                  />
                  Assigned to me
                </label>
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
            </div>
          </DialogPanel>
        ) : (
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="flex flex-col gap-0.5">
                  <span>First message</span>
                  <span className="text-xs text-muted-foreground">
                    Your instructions come first; the issues follow. Both can be edited.
                  </span>
                </span>
                <Textarea
                  value={instructionsText}
                  onChange={(event) => setInstructions(event.target.value)}
                  rows={4}
                  aria-label="Instructions for the agent"
                />
                <Textarea
                  value={sections}
                  onChange={(event) => setSections(event.target.value)}
                  rows={10}
                  aria-label="The issues, as the agent will read them"
                />
              </div>

              {repositoryProjects.length > 0 ? (
                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="flex flex-col gap-0.5">
                    <span>Repository</span>
                    <span className="text-xs text-muted-foreground">
                      You already have {repository} as a project. Work there, or clone a fresh copy.
                    </span>
                  </span>
                  <Select
                    value={activeChoice as string}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      setWorkspaceChoice(value as WorkspaceChoice);
                    }}
                  >
                    <SelectTrigger aria-label="Repository to work in">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {workspaceItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}

              <label className="flex items-start gap-2.5 text-sm">
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
              </label>
            </div>
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
              {/* The thread starts on this model; a pick here is carried into the composer. */}
              <div className="me-auto">
                <IssueModelPicker
                  environmentId={environmentId}
                  project={activeProject}
                  value={modelSelection}
                  onChange={setModelSelection}
                />
              </div>
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

/**
 * The model and effort the thread starts with. It opens on the project's
 * default model, so a thread the user does not touch starts the way it always did.
 */
function IssueModelPicker({
  environmentId,
  project,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  /** The user's pick; null follows the project default. */
  readonly value: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const projectDefault = project
    ? (resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
      project.defaultModelSelection)
    : settings.defaultModelSelection;
  const selection = resolveDefaultProviderModelSelection(providers, value ?? projectDefault);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      project?.id ?? null,
    ),
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  if (!selection || !activeEntry) return null;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );

  return (
    <div className="flex items-center gap-1">
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={activeEntry.driverKind}
        instanceId={selection.instanceId}
        models={activeEntry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
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
            <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
              {formatRelativeTimeLabel(issue.updatedAt)}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
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
            <span className="line-clamp-1 text-2xs text-secondary-label">{issue.summary}</span>
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
