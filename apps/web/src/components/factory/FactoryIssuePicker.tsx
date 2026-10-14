import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SourceControlIssueSummary } from "@t3tools/contracts";
import { CircleDotIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useProjects } from "../../state/entities";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useUiStateStore } from "../../uiStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { issueKey, parseIssueLookup } from "../issues/issuePicker.logic";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { projectRepositorySlug, resolveFactoryProject } from "./factory.logic";
import { useStartFactoryTask } from "./useStartFactoryTask";

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_ROWS = 40;
const ALL_REPOSITORIES = "all";

/**
 * Pick GitHub issues and start factory tasks on them. The repository list comes from the
 * projects on the server, so a picked issue always has a project to run in. The last
 * repository is remembered. Several issues start one task each, or one task for all.
 */
export function FactoryIssuePicker({
  open,
  onOpenChange,
  environmentId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
}) {
  const projects = useProjects();
  const searchIssues = useAtomQueryRunner(sourceControlEnvironment.issues, {
    reportFailure: false,
  });
  const loadIssueDetails = useAtomQueryRunner(sourceControlEnvironment.issueDetails, {
    reportFailure: false,
  });
  const startTask = useStartFactoryTask();
  const lastRepository = useUiStateStore((state) => state.factoryLastIssueRepository);
  const setLastRepository = useUiStateStore((state) => state.setFactoryLastIssueRepository);

  const repositories = useMemo(() => {
    const slugs = new Set<string>();
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const slug = projectRepositorySlug(project);
      if (slug) slugs.add(slug);
    }
    return [...slugs].sort();
  }, [environmentId, projects]);
  const [repository, setRepository] = useState<string>(
    lastRepository && repositories.includes(lastRepository) ? lastRepository : ALL_REPOSITORIES,
  );
  const [query, setQuery] = useState("");
  const [assignedToViewer, setAssignedToViewer] = useState(true);
  const [oneTask, setOneTask] = useState(false);
  const [issues, setIssues] = useState<ReadonlyArray<SourceControlIssueSummary>>([]);
  const [selected, setSelected] = useState<ReadonlyArray<SourceControlIssueSummary>>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Only the newest search may write the list.
  const searchGeneration = useRef(0);

  const runSearch = useCallback(
    async (text: string, filterToViewer: boolean, scope: string) => {
      const generation = ++searchGeneration.current;
      setSearching(true);
      const locked = scope === ALL_REPOSITORIES ? null : scope;
      const lookup = parseIssueLookup(text, locked);
      const result =
        lookup.kind === "issue"
          ? await loadIssueDetails({
              environmentId,
              input: {
                provider: "github",
                issues: [{ repository: lookup.repository, number: lookup.number }],
              },
            }).then((outcome) =>
              outcome._tag === "Failure"
                ? outcome
                : { ...outcome, value: { issues: outcome.value.issues, truncated: false } },
            )
          : await searchIssues({
              environmentId,
              input: {
                provider: "github",
                query: lookup.query,
                assignedToViewer: filterToViewer,
                repository: lookup.repository ?? locked,
                limit: SEARCH_ROWS,
              },
            });
      if (generation !== searchGeneration.current) return;
      setSearching(false);
      if (result._tag === "Failure") {
        setIssues([]);
        setTruncated(false);
        setFailure(
          squashAtomCommandFailure(result) instanceof Error
            ? (squashAtomCommandFailure(result) as Error).message
            : "The search failed.",
        );
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
      void runSearch(query, assignedToViewer, repository);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [assignedToViewer, open, query, repository, runSearch]);

  const close = () => {
    searchGeneration.current += 1;
    setQuery("");
    setIssues([]);
    setSelected([]);
    setTruncated(false);
    setFailure(null);
    setSearching(false);
    onOpenChange(false);
  };
  const selectedKeys = useMemo(() => new Set(selected.map(issueKey)), [selected]);
  const toggle = (issue: SourceControlIssueSummary) =>
    setSelected((current) =>
      current.some((each) => issueKey(each) === issueKey(issue))
        ? current.filter((each) => issueKey(each) !== issueKey(issue))
        : [...current, issue],
    );

  // One task holds issues from one repository, because one task is one branch.
  const selectedRepositories = new Set(selected.map((issue) => issue.repository.toLowerCase()));
  const oneTaskPossible = selectedRepositories.size <= 1;

  const projectFor = (slug: string): EnvironmentProject | null => {
    const resolution = resolveFactoryProject(
      { kind: "github-issue", value: `https://github.com/${slug}/issues/1` },
      projects.filter((project) => project.environmentId === environmentId),
    );
    return resolution.kind === "resolved" ? resolution.project : null;
  };

  // Each start prepares a worktree, which takes seconds. The dialog closes at once and the
  // starts run together; a toast reports the outcome.
  const start = async () => {
    if (selected.length === 0 || starting) return;
    setStarting(true);
    const batches: ReadonlyArray<ReadonlyArray<SourceControlIssueSummary>> =
      oneTask && oneTaskPossible ? [selected] : selected.map((issue) => [issue]);
    const startFor = async (batch: ReadonlyArray<SourceControlIssueSummary>) => {
      const first = batch[0]!;
      const project = projectFor(first.repository);
      if (!project) {
        return {
          ok: false as const,
          title: `No project for ${first.repository}`,
          detail: "Add the repository as a project first.",
        };
      }
      return batch.length === 1
        ? startTask({ kind: "github-issue", value: first.url }, project, {
            title: `#${first.number} ${first.title}`.slice(0, 80),
          })
        : startTask(
            {
              kind: "free-text",
              value: [
                ...batch.map((issue) => issue.url),
                "",
                "Work on all of these issues together as one change.",
              ].join("\n"),
            },
            project,
            { title: `${batch.length} issues in ${first.repository}`.slice(0, 80) },
          );
    };
    setLastRepository(repository === ALL_REPOSITORIES ? null : repository);
    const pending = batches.length;
    toastManager.add({
      type: "info",
      title: pending === 1 ? "Starting the factory task" : `Starting ${pending} factory tasks`,
      description: "Each one gets its own worktree. They appear on the page as they start.",
    });
    close();
    setStarting(false);
    // One checkout at a time per repository: git refuses two worktree checkouts at once in
    // the same repository. Different repositories still run side by side.
    const byRepository = new Map<string, ReadonlyArray<SourceControlIssueSummary>[]>();
    for (const batch of batches) {
      const repository = batch[0]!.repository.toLowerCase();
      byRepository.set(repository, [...(byRepository.get(repository) ?? []), batch]);
    }
    const results = (
      await Promise.all(
        [...byRepository.values()].map(async (queue) => {
          const outcomes = [];
          for (const batch of queue) outcomes.push(await startFor(batch));
          return outcomes;
        }),
      )
    ).flat();
    const failed = results.filter((result) => !result.ok);
    for (const result of failed) {
      if (!result.ok) {
        toastManager.add({ type: "error", title: result.title, description: result.detail });
      }
    }
    const started = results.length - failed.length;
    if (started > 0) {
      toastManager.add({
        type: "success",
        title: started === 1 ? "Factory task started" : `${started} factory tasks started`,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start from issues</DialogTitle>
          <DialogDescription>
            Pick one or more GitHub issues. Each one becomes a factory task, or all of them become
            one task.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select
                value={repository}
                onValueChange={(value) => {
                  setRepository(value ?? ALL_REPOSITORIES);
                  setSelected([]);
                }}
              >
                <SelectTrigger size="sm" aria-label="Repository">
                  <SelectValue>
                    {(value: string | null) =>
                      value === null || value === ALL_REPOSITORIES ? "All repositories" : value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_REPOSITORIES}>All repositories</SelectItem>
                  {repositories.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Label>
                <span className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    checked={assignedToViewer}
                    onCheckedChange={(checked) => setAssignedToViewer(checked === true)}
                  />
                  Assigned to me
                </span>
              </Label>
            </div>
            <div className="relative">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search issues, or paste an issue link or number"
                autoFocus
              />
              {searching ? (
                <LoaderCircleIcon
                  aria-hidden
                  className="absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
                />
              ) : null}
            </div>
            {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
            <ul className="max-h-80 overflow-y-auto rounded-md border border-border/60">
              {issues.length === 0 && !searching ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No issues found.
                </li>
              ) : null}
              {issues.map((issue) => {
                const checked = selectedKeys.has(issueKey(issue));
                return (
                  <li key={issueKey(issue)} className="border-b border-border/40 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggle(issue)}
                      aria-pressed={checked}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted/50 data-[selected=true]:bg-muted/70"
                      data-selected={checked}
                    >
                      <Checkbox
                        checked={checked}
                        className="pointer-events-none mt-1"
                        tabIndex={-1}
                      />
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
                        <span className="truncate text-2xs text-muted-foreground">
                          {issue.repository}#{issue.number}
                          {issue.state === "closed" ? " · Closed" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                More issues match. Narrow the search to see them.
              </p>
            ) : null}
            <Label>
              <span className="flex items-center gap-2">
                <Switch
                  size="sm"
                  checked={oneTask && oneTaskPossible}
                  disabled={!oneTaskPossible}
                  onCheckedChange={(checked) => setOneTask(checked === true)}
                />
                One task for all selected issues
                {!oneTaskPossible ? (
                  <span className="text-muted-foreground">(needs issues from one repository)</span>
                ) : null}
              </span>
            </Label>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close} disabled={starting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void start()}
            disabled={selected.length === 0 || starting}
          >
            {starting
              ? "Starting..."
              : selected.length <= 1
                ? "Run the code-factory"
                : oneTask && oneTaskPossible
                  ? `Run one task for ${selected.length} issues`
                  : `Run ${selected.length} tasks`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
