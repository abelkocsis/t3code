import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  classifyFactoryInput,
  DEFAULT_SERVER_SETTINGS,
  FACTORY_PHASE_LABELS,
  FACTORY_BLOCKED_SNOOZE_MS,
  type FactoryInput,
  type PullRequestMergeMethod,
  type SlackThreadRef,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import type * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  AlarmClockIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CircleDotIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useFactoryFolders } from "../../hooks/useFactoryFolders";
import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { newMessageId } from "../../lib/utils";
import { cn } from "../../lib/utils";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  useProjects,
  useServerConfigs,
  useThreadDetail,
  useThreadShells,
} from "../../state/entities";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useRightPanelStore } from "../../rightPanelStore";
import { useUiStateStore } from "../../uiStateStore";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
import { requestFolderName } from "../FolderNameDialog";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  readableFailure,
} from "../pullRequest/pullRequestDetail.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildReviewRequestMessage,
  collectFactoryTasks,
  isReReviewRequest,
  FACTORY_TASK_STATE_LABELS,
  factoryTaskKey,
  formatElapsed,
  orderFactoryTasks,
  resolveFactoryProject,
  type FactoryTask,
  type FactoryTaskState,
} from "./factory.logic";
import { FactoryIssuePicker } from "./FactoryIssuePicker";
import { useStartFactoryTask } from "./useStartFactoryTask";

const STATE_BADGE: Record<
  FactoryTaskState,
  "warning" | "info" | "error" | "success" | "secondary"
> = {
  waiting: "warning",
  working: "info",
  idle: "secondary",
  snoozed: "secondary",
  error: "error",
  done: "success",
};

const FOLDER_DROP_PREFIX = "folder:";
const COLLAPSED_KEY = "t3code:factory-collapsed-folders:v1";
const CollapsedSchema = Schema.Array(Schema.String);

function readCollapsed(): ReadonlySet<string> {
  try {
    return new Set(getLocalStorageItem(COLLAPSED_KEY, CollapsedSchema) ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Factory tasks by folder, then the tasks in no folder, then the finished ones. Folders are
 * the Factory page's own, kept apart from the sidebar folders. One drag context covers the
 * folders and the tasks: a folder dropped on a folder reorders them, a task dropped on a
 * folder or on one of its rows files it there.
 */
export function FactoryPage() {
  useEscapeToGoBack();
  const navigate = useNavigate();
  const threads = useThreadShells();
  const folders = useFactoryFolders();
  const setFactory = useAtomCommand(threadEnvironment.setFactory, { reportFailure: false });
  const order = useUiStateStore((state) => state.factoryTaskOrder);
  const setOrder = useUiStateStore((state) => state.setFactoryTaskOrder);
  const tasks = useMemo(
    () => orderFactoryTasks(collectFactoryTasks(threads), order),
    [order, threads],
  );
  const active = tasks.filter((task) => task.state !== "done");
  const completed = tasks.filter((task) => task.state === "done");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Ready-for-review tasks ticked for one combined review request.
  const [checkedKeys, setCheckedKeys] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const toggleFolder = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      try {
        setLocalStorageItem(COLLAPSED_KEY, [...next], CollapsedSchema);
      } catch {
        // A full or blocked storage only loses the open/closed memory.
      }
      return next;
    });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // A short distance keeps a plain click on the handle from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const storedLayout = useMemo(() => {
    const folderIds = new Set(folders.folders.map((folder) => folder.id));
    const byFolder = new Map<string | null, FactoryTask[]>();
    for (const task of active) {
      // A task whose folder was deleted sits below the folders again.
      const id =
        task.factory.folderId && folderIds.has(task.factory.folderId)
          ? task.factory.folderId
          : null;
      byFolder.set(id, [...(byFolder.get(id) ?? []), task]);
    }
    return byFolder;
  }, [active, folders.folders]);
  // While a row is dragged, the page shows it in the folder under the pointer so the rows
  // there make room for it. The stored layout takes over again once the drop is saved.
  const [dragLayout, setDragLayout] = useState<Map<string | null, FactoryTask[]> | null>(null);
  const tasksByFolder = dragLayout ?? storedLayout;
  const unfiled = tasksByFolder.get(null) ?? [];
  const containerOf = (layout: Map<string | null, FactoryTask[]>, key: string) => {
    for (const [container, members] of layout) {
      if (members.some((task) => factoryTaskKey(task) === key)) return container;
    }
    return undefined;
  };

  const openThread = (task: FactoryTask) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(task.thread.environmentId, task.thread.id)),
    });
  };
  const fileTask = async (task: FactoryTask, folderId: string | null) => {
    if ((task.factory.folderId ?? null) === folderId) return;
    const result = await setFactory({
      environmentId: task.thread.environmentId,
      input: { threadId: task.thread.id, factory: { ...task.factory, folderId } },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not move the task into the folder" });
    }
  };
  // The dragged row floats in an overlay so it follows the pointer across folders; its
  // placeholder moves through the lists with it and the other rows shift around it.
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const draggingTask = tasks.find((task) => factoryTaskKey(task) === draggingKey) ?? null;
  const onDragStart = (event: DragStartEvent) => {
    setDraggingKey(String(event.active.id));
    setDragLayout(new Map([...storedLayout].map(([id, members]) => [id, [...members]])));
  };
  const onDragOver = (event: DragOverEvent) => {
    const { active: dragged, over } = event;
    if (!over) return;
    const draggedId = String(dragged.id);
    const overId = String(over.id);
    setDragLayout((current) => {
      if (!current) return current;
      const from = containerOf(current, draggedId);
      const to = overId.startsWith(FOLDER_DROP_PREFIX)
        ? overId.slice(FOLDER_DROP_PREFIX.length)
        : containerOf(current, overId);
      if (from === undefined || to === undefined || from === to) return current;
      const next = new Map([...current].map(([id, members]) => [id, [...members]]));
      const source = next.get(from) ?? [];
      const index = source.findIndex((task) => factoryTaskKey(task) === draggedId);
      const [moved] = source.splice(index, 1);
      if (!moved) return current;
      const target = next.get(to) ?? [];
      const overIndex = target.findIndex((task) => factoryTaskKey(task) === overId);
      target.splice(overIndex === -1 ? target.length : overIndex, 0, moved);
      next.set(from, source);
      next.set(to, target);
      return next;
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingKey(null);
    const { active: dragged, over } = event;
    const draggedId = String(dragged.id);
    const task = tasks.find((candidate) => factoryTaskKey(candidate) === draggedId);
    const layout = dragLayout;
    setDragLayout(null);
    if (!over || !task || !layout) return;
    const container = containerOf(layout, draggedId);
    if (container === undefined) return;
    const overId = String(over.id);
    const members = layout.get(container) ?? [];
    const ordered =
      overId === draggedId || overId.startsWith(FOLDER_DROP_PREFIX)
        ? members
        : (() => {
            // The last over event already placed the row; the drop only fixes its slot.
            const keys = members.map(factoryTaskKey);
            const from = keys.indexOf(draggedId);
            const to = keys.indexOf(overId);
            if (from === -1 || to === -1) return members;
            const next = [...members];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved!);
            return next;
          })();
    const finalLayout = new Map(layout);
    finalLayout.set(container, ordered);
    void fileTask(task, container);
    setOrder(
      [
        ...folders.folders.flatMap((folder) => finalLayout.get(folder.id) ?? []),
        ...(finalLayout.get(null) ?? []),
      ].map(factoryTaskKey),
    );
  };
  const newFolder = async () => {
    const name = await requestFolderName({
      title: "New folder",
      description: "Group factory tasks under one heading.",
      confirmLabel: "Create",
      takenNames: folders.folders.map((folder) => folder.name),
    });
    if (name !== null) await folders.createFolder(name);
  };
  const renameFolder = async (id: string, current: string) => {
    const name = await requestFolderName({
      title: "Rename folder",
      description: "The tasks inside keep their place.",
      confirmLabel: "Rename",
      initialValue: current,
      takenNames: folders.folders.filter((folder) => folder.id !== id).map((folder) => folder.name),
    });
    if (name !== null && name !== current) await folders.renameFolder(id, name);
  };

  const renderRow = (task: FactoryTask) => {
    const key = factoryTaskKey(task);
    const selected = selectedKey === key;
    return (
      <div key={key} className="flex flex-col gap-2">
        <TaskRow
          task={task}
          now={now}
          selected={selected}
          checked={task.factory.phase === "ready-for-review" ? checkedKeys.has(key) : null}
          onCheckedChange={(next) =>
            setCheckedKeys((current) => {
              const set = new Set(current);
              if (next) set.add(key);
              else set.delete(key);
              return set;
            })
          }
          onSelect={() => setSelectedKey((current) => (current === key ? null : key))}
          onOpen={() => openThread(task)}
        />
        {selected ? <GatePanel key={key} task={task} /> : null}
      </div>
    );
  };
  const checked = active.filter(
    (task) => task.factory.phase === "ready-for-review" && checkedKeys.has(factoryTaskKey(task)),
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Factory breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current>
                <h1>Factory</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            {checked.length > 0 ? (
              <CombinedReviewRequest tasks={checked} onDone={() => setCheckedKeys(new Set())} />
            ) : null}
            {folders.supported ? (
              <Button size="xs" variant="ghost" onClick={() => void newFolder()}>
                <FolderPlusIcon aria-hidden className="size-3.5" />
                New folder
              </Button>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <div className="flex flex-col gap-6">
              <StartTaskForm />
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No factory tasks yet.</p>
              ) : null}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDragCancel={() => {
                  setDraggingKey(null);
                  setDragLayout(null);
                }}
              >
                {/* One sortable list per container: rows shift only inside their own folder,
                    and a row dragged onto another folder's header or rows files it there. */}
                <div className="flex flex-col gap-4">
                  {folders.folders.map((folder, index) => {
                    const members = tasksByFolder.get(folder.id) ?? [];
                    return (
                      <FolderSection
                        key={folder.id}
                        id={folder.id}
                        name={folder.name}
                        tasks={members}
                        expanded={!collapsed.has(folder.id)}
                        canMoveUp={index > 0}
                        canMoveDown={index < folders.folders.length - 1}
                        onToggle={() => toggleFolder(folder.id)}
                        onMove={(direction) =>
                          void folders.moveFolder(folder.id, index + (direction === "up" ? -1 : 1))
                        }
                        onRename={() => void renameFolder(folder.id, folder.name)}
                        onDelete={() => void folders.deleteFolder(folder.id)}
                      >
                        <SortableContext
                          items={members.map(factoryTaskKey)}
                          strategy={verticalListSortingStrategy}
                        >
                          {members.map(renderRow)}
                        </SortableContext>
                      </FolderSection>
                    );
                  })}
                  {unfiled.length > 0 ? (
                    <SortableContext
                      items={unfiled.map(factoryTaskKey)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="flex flex-col gap-2">{unfiled.map(renderRow)}</div>
                    </SortableContext>
                  ) : null}
                </div>
                <DragOverlay dropAnimation={null}>
                  {draggingTask ? (
                    <div className="pointer-events-none w-fit max-w-md cursor-grabbing select-none truncate rounded-md border border-border bg-background px-3 py-2 text-sm shadow-md">
                      {draggingTask.thread.title}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
              {completed.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">
                    Completed{" "}
                    <span className="text-muted-foreground tabular-nums">{completed.length}</span>
                  </h2>
                  <div className="flex flex-col gap-2">{completed.map(renderRow)}</div>
                </section>
              ) : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/**
 * One folder: a header that opens and closes it and takes a dropped task, arrows to move
 * the folder, then its rows. The grey number counts the tasks, the amber one those waiting.
 */
function FolderSection({
  id,
  name,
  tasks,
  expanded,
  canMoveUp,
  canMoveDown,
  onToggle,
  onMove,
  onRename,
  onDelete,
  children,
}: {
  id: string;
  name: string;
  tasks: ReadonlyArray<FactoryTask>;
  expanded: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onMove: (direction: "up" | "down") => void;
  onRename: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${FOLDER_DROP_PREFIX}${id}` });
  const waiting = tasks.filter((task) => task.state === "waiting").length;
  return (
    <section className="flex flex-col gap-2">
      <div
        ref={setNodeRef}
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium text-foreground",
          "hover:bg-accent/50",
          isOver && "bg-accent/60 ring-2 ring-ring",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
          <FolderIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="truncate">{name}</span>
          <span className="text-muted-foreground tabular-nums">{tasks.length}</span>
          {waiting > 0 ? (
            <Badge variant="warning" aria-label={`${waiting} waiting on you`}>
              {waiting}
            </Badge>
          ) : null}
        </button>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move folder up"
            disabled={!canMoveUp}
            onClick={() => onMove("up")}
          >
            <ArrowUpIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Move folder down"
            disabled={!canMoveDown}
            onClick={() => onMove("down")}
          >
            <ArrowDownIcon aria-hidden className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Rename folder" onClick={onRename}>
            <PencilIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete folder"
            title="The tasks inside move below the folders."
            onClick={onDelete}
          >
            <Trash2Icon aria-hidden className="size-3.5" />
          </Button>
        </span>
      </div>
      {expanded ? (
        <div className="ms-4 flex flex-col gap-2">
          {tasks.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">Drop a task here.</p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
}

function TaskRow({
  task,
  now,
  selected,
  checked,
  onCheckedChange,
  onSelect,
  onOpen,
}: {
  task: FactoryTask;
  now: number;
  selected: boolean;
  /** Null hides the box: only ready-for-review tasks join a combined review request. */
  checked: boolean | null;
  onCheckedChange: (checked: boolean) => void;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const rename = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const opensInBrowser = useClientSettings((s) => s.factoryPullRequestOpensInBrowser);
  const projects = useProjects();
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === task.thread.environmentId &&
      candidate.id === task.thread.projectId,
  );
  const key = factoryTaskKey(task);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
  });
  const [draftTitle, setDraftTitle] = useState<string | null>(null);

  // The pull request opens in the thread's own panel, unless the setting sends it to the browser.
  const openPullRequest = () => {
    const pullRequest = task.pullRequest;
    if (!pullRequest) return;
    if (opensInBrowser) {
      window.open(pullRequest.url, "_blank", "noopener,noreferrer");
      return;
    }
    const ref = scopeThreadRef(task.thread.environmentId, task.thread.id);
    useRightPanelStore.getState().openPullRequest(ref, {
      environmentId: task.thread.environmentId,
      projectId: task.thread.projectId,
      host: pullRequest.host,
      repository: pullRequest.repository,
      number: pullRequest.number,
      url: pullRequest.url,
    });
    onOpen();
  };
  const commitTitle = async () => {
    const title = draftTitle?.trim() ?? "";
    setDraftTitle(null);
    if (title.length === 0 || title === task.thread.title) return;
    const result = await rename({
      environmentId: task.thread.environmentId,
      input: { threadId: task.thread.id, title },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not rename the task" });
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      role="button"
      tabIndex={0}
      aria-expanded={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none",
        "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent/40",
        isDragging && "opacity-40",
      )}
    >
      <button
        type="button"
        className={cn(
          "shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
          "group-hover:opacity-100 focus-visible:opacity-100",
          isDragging && "cursor-grabbing opacity-100",
        )}
        aria-label="Reorder this task"
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      {checked !== null ? (
        <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            aria-label="Include in the review request"
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next === true)}
          />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {draftTitle !== null ? (
          <Input
            size="compact"
            autoFocus
            value={draftTitle}
            aria-label="Task name"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") void commitTitle();
              if (event.key === "Escape") setDraftTitle(null);
            }}
          />
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="truncate text-start text-sm text-foreground hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
            >
              {task.thread.title}
            </button>
            <button
              type="button"
              aria-label="Rename task"
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                setDraftTitle(task.thread.title);
              }}
            >
              <PencilIcon className="size-3" />
            </button>
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {project?.title ?? "Unknown project"}
          {task.factory.summary ? ` · ${task.factory.summary}` : ""}
        </span>
      </div>
      <span
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
        aria-label="Time in this stage"
      >
        {formatElapsed(task.factory.updatedAt, now)}
      </span>
      <Badge variant="outline">{FACTORY_PHASE_LABELS[task.factory.phase]}</Badge>
      <Badge variant={STATE_BADGE[task.state]}>{FACTORY_TASK_STATE_LABELS[task.state]}</Badge>
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <ReviewActions task={task} />
        {task.pullRequest ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Open pull request"
            onClick={openPullRequest}
          >
            <PullRequestGlyph.pullRequest aria-hidden className="size-4" />
          </Button>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label="Open as thread" onClick={onOpen}>
          <MessageSquareIcon aria-hidden className="size-4" />
        </Button>
        <TaskMenu task={task} />
      </div>
    </div>
  );
}

/** A wake time far enough ahead that only the merge check or the user ends the sleep. */
function blockedSnoozeUntil(): string {
  return new Date(Date.now() + FACTORY_BLOCKED_SNOOZE_MS).toISOString();
}

/** Snooze, wake, and archive live behind one button so the row stays readable. */
function TaskMenu({ task }: { task: FactoryTask }) {
  const { archiveThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const setFactory = useAtomCommand(threadEnvironment.setFactory, { reportFailure: false });
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const ref = scopeThreadRef(task.thread.environmentId, task.thread.id);
  const presets = resolveSnoozePresets(new Date(), timestampFormat);
  const blockedBy = task.factory.blockedBy ?? null;

  const report = (ok: boolean, title: string) => {
    if (!ok) toastManager.add({ type: "error", title });
  };
  const snoozeUntil = async (snoozedUntil: string) => {
    const result = await snoozeThread(ref, snoozedUntil);
    report(result._tag === "Success", "Could not snooze the task");
  };
  const wake = async () => {
    if (blockedBy) {
      await setFactory({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId, factory: { ...task.factory, blockedBy: null } },
      });
    }
    const result = await unsnoozeThread(ref);
    report(result._tag === "Success", "Could not wake the task");
  };
  const archive = async () => {
    const result = await archiveThread(ref);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not archive the task",
        description: "Stop the running turn first.",
      });
    }
  };
  const blockOn = async (url: string) => {
    const parsed = parseChangeRequestUrl(url);
    if (!parsed) {
      toastManager.add({ type: "error", title: "That is not a pull request link" });
      return;
    }
    const flagged = await setFactory({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        factory: {
          ...task.factory,
          blockedBy: {
            url,
            host: parsed.host,
            repository: parsed.repository,
            number: parsed.number,
          },
        },
      },
    });
    if (flagged._tag === "Failure") {
      report(false, "Could not record the blocking pull request");
      return;
    }
    await snoozeUntil(blockedSnoozeUntil());
    toastManager.add({
      type: "success",
      title: `Sleeping until ${parsed.repository}#${parsed.number} merges`,
      description: "The server checks once an hour.",
    });
  };
  const showInSidebar = task.factory.showInSidebar === true;
  const toggleSidebar = async () => {
    const result = await setFactory({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        factory: { ...task.factory, showInSidebar: !showInSidebar },
      },
    });
    report(result._tag === "Success", "Could not change the sidebar setting");
  };
  const wakeLabel = blockedBy
    ? `Wake up (sleeping until ${blockedBy.repository}#${blockedBy.number} merges)`
    : task.thread.snoozedUntil
      ? `Wake up (snoozed until ${snoozeWakeDescription(task.thread.snoozedUntil, new Date(), timestampFormat)})`
      : "Wake up";

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
          <EllipsisIcon aria-hidden className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {task.state === "snoozed" ? (
            <MenuItem onClick={() => void wake()}>
              <AlarmClockIcon aria-hidden className="size-3.5" />
              {wakeLabel}
            </MenuItem>
          ) : (
            <MenuSub>
              <MenuSubTrigger>
                <AlarmClockIcon aria-hidden className="size-3.5" />
                Snooze
              </MenuSubTrigger>
              <MenuSubPopup>
                {presets.map((preset) => (
                  <MenuItem key={preset.id} onClick={() => void snoozeUntil(preset.snoozedUntil)}>
                    {preset.label}
                    <span className="ms-auto ps-4 text-muted-foreground">{preset.whenLabel}</span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  onClick={() =>
                    void requestCustomSnooze().then((choice) =>
                      choice ? snoozeUntil(choice.snoozedUntil) : undefined,
                    )
                  }
                >
                  Custom…
                </MenuItem>
                <MenuItem onClick={() => setBlockDialogOpen(true)}>
                  Until a pull request merges…
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuSeparator />
          <MenuCheckboxItem checked={showInSidebar} onCheckedChange={() => void toggleSidebar()}>
            Show in sidebar
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuItem onClick={() => void archive()}>
            <ArchiveIcon aria-hidden className="size-3.5" />
            Archive task
          </MenuItem>
        </MenuPopup>
      </Menu>
      <BlockingPullRequestDialog
        open={blockDialogOpen}
        onOpenChange={setBlockDialogOpen}
        onSubmit={(url) => void blockOn(url)}
      />
    </>
  );
}

/** Asks for the pull request link a task should sleep behind. */
function BlockingPullRequestDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const submit = () => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setUrl("");
    onOpenChange(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Sleep until a pull request merges</AlertDialogTitle>
          <AlertDialogDescription>
            Paste the link of the pull request this task waits on. The task wakes within an hour of
            the merge.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={url}
          placeholder="https://github.com/owner/repo/pull/123"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button size="sm" disabled={url.trim().length === 0} onClick={submit}>
            Sleep
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * What the human does at each review stage. Ready for review: send the request and mark the
 * task under review. Ready to merge: merge. The server moves the task between the stages.
 */
function ReviewActions({ task }: { task: FactoryTask }) {
  const setFactory = useAtomCommand(threadEnvironment.setFactory, { reportFailure: false });
  const phase = task.factory.phase;
  const pullRequest = task.pullRequest;
  if (!pullRequest) return null;

  const markUnderReview = async () => {
    const now = new Date().toISOString();
    const snapshot = pullRequest.snapshot;
    const result = await setFactory({
      environmentId: task.thread.environmentId,
      input: {
        threadId: task.thread.id,
        factory: {
          ...task.factory,
          phase: "under-review",
          summary: "Waiting on reviewers.",
          updatedAt: now,
          reviewRound: (task.factory.reviewRound ?? 0) + 1,
          // Comments already on the pull request count as new work; checks and the base
          // state start from what the pull request shows now.
          review: {
            seenUpdatedAt: null,
            seenUnresolved: 0,
            seenChecksState: snapshot?.checksState ?? null,
            seenMergeState: snapshot?.mergeState ?? null,
          },
        },
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not mark the task under review" });
    }
  };

  const copyRequest = async () => {
    try {
      await writeTextToClipboard(
        buildReviewRequestMessage([pullRequest.url], { reReview: isReReviewRequest([task]) }),
        "review request",
      );
      toastManager.add({ type: "success", title: "Review request copied" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy review request",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (phase === "ready-for-review") {
    return (
      <>
        <Button size="xs" variant="outline" onClick={() => void copyRequest()}>
          <CopyIcon aria-hidden className="size-3.5" />
          {isReReviewRequest([task]) ? "Copy re-review message" : "Copy Slack message"}
        </Button>
        {task.thread.slackThread ? (
          <SendToSlackButton
            environmentId={task.thread.environmentId}
            slackThread={task.thread.slackThread}
            urls={[pullRequest.url]}
            reReview={isReReviewRequest([task])}
          />
        ) : null}
        <Button size="xs" onClick={() => void markUnderReview()}>
          Mark under review
        </Button>
      </>
    );
  }
  if (phase === "ready-to-merge") {
    return <MergeButton task={task} />;
  }
  return null;
}

/**
 * One review request for every ticked task. Send to Slack appears when all of them link the
 * same Slack thread.
 */
function CombinedReviewRequest({
  tasks,
  onDone,
}: {
  tasks: ReadonlyArray<FactoryTask>;
  onDone: () => void;
}) {
  const urls = tasks.flatMap((task) => (task.pullRequest ? [task.pullRequest.url] : []));
  const first = tasks[0];
  const slackThread = first?.thread.slackThread ?? null;
  const sameSlackThread =
    slackThread !== null &&
    tasks.every(
      (task) =>
        task.thread.environmentId === first?.thread.environmentId &&
        task.thread.slackThread?.channelId === slackThread.channelId &&
        task.thread.slackThread?.threadTs === slackThread.threadTs,
    );
  const copy = async () => {
    try {
      await writeTextToClipboard(
        buildReviewRequestMessage(urls, { reReview: isReReviewRequest(tasks) }),
        "review request",
      );
      toastManager.add({ type: "success", title: `Review request for ${urls.length} copied` });
      onDone();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy review request",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <span className="flex items-center gap-1.5">
      <Button size="xs" variant="outline" onClick={() => void copy()}>
        <CopyIcon aria-hidden className="size-3.5" />
        Copy Slack message for {urls.length}
      </Button>
      {sameSlackThread && first ? (
        <SendToSlackButton
          environmentId={first.thread.environmentId}
          slackThread={slackThread}
          urls={urls}
          reReview={isReReviewRequest(tasks)}
          onSent={onDone}
        />
      ) : null}
    </span>
  );
}

/** Posts the request as a reply in the Slack thread, as the user, through their Slack connection. */
function SendToSlackButton({
  environmentId,
  slackThread,
  urls,
  reReview,
  onSent,
}: {
  environmentId: FactoryTask["thread"]["environmentId"];
  slackThread: SlackThreadRef;
  urls: ReadonlyArray<string>;
  reReview: boolean;
  onSent?: () => void;
}) {
  const reply = useAtomCommand(serverEnvironment.replyInSlackThread, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const result = await reply({
      environmentId,
      input: { thread: slackThread, text: buildReviewRequestMessage(urls, { reReview }) },
    });
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not send to Slack",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Check that the Claude provider is signed in and its Slack connection works.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: "Review request sent to Slack" });
    onSent?.();
  };
  return (
    <Button size="xs" variant="outline" disabled={sending} onClick={() => void send()}>
      <SendIcon aria-hidden className="size-3.5" />
      {sending ? "Sending..." : "Send to Slack"}
    </Button>
  );
}

/** Merges with the project's merge method after a confirmation, then settles the thread. */
function MergeButton({ task }: { task: FactoryTask }) {
  const { settleThread } = useThreadActions();
  const environmentConfigs = useServerConfigs();
  const lastSelectedMergeMethod = useUiStateStore((state) => state.pullRequestMergeMethod);
  const method: PullRequestMergeMethod =
    resolveProjectSettings(
      environmentConfigs.get(task.thread.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
      task.thread.projectId,
    ).settings.pullRequestMergeMethod ?? lastSelectedMergeMethod;
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const pullRequest = task.pullRequest;
  if (!pullRequest) return null;

  const merge = async () => {
    setPending(true);
    const result = await runAction({
      environmentId: task.thread.environmentId,
      input: {
        projectId: task.thread.projectId,
        host: pullRequest.host,
        repository: pullRequest.repository,
        number: pullRequest.number,
        action: "merge",
        mergeMethod: method,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not merge #${pullRequest.number}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Check the pull request on the host for what still blocks it.",
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Merged #${pullRequest.number}` });
    await settleThread(scopeThreadRef(task.thread.environmentId, task.thread.id));
  };

  return (
    <>
      <Button size="xs" disabled={pending} onClick={() => setConfirming(true)}>
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        {pending ? "Merging..." : "Merge"}
      </Button>
      <AlertDialog open={confirming} onOpenChange={(open) => (!open ? setConfirming(false) : null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This merges #${pullRequest.number} using ${PULL_REQUEST_MERGE_METHOD_LABELS[method].toLowerCase()}, then settles the thread.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                void merge();
              }}
            >
              Merge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * The question the agent asked, with its options, the agent's latest reply, and a reply box.
 * Approvals need the full thread, so they only link there.
 */
function GatePanel({ task }: { task: FactoryTask }) {
  const navigate = useNavigate();
  const ref = scopeThreadRef(task.thread.environmentId, task.thread.id);
  const detail = useThreadDetail(ref);
  const { approvals, userInputs } = useMemo(
    () => derivePendingRequests(detail?.activities ?? []),
    [detail?.activities],
  );
  const latestReply = useMemo(
    () => detail?.messages.findLast((message) => message.role === "assistant") ?? null,
    [detail?.messages],
  );
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const pending = userInputs[0] ?? null;
  // One request carries several questions; the answer goes out once every question has one.
  const answers = pending ? buildPendingUserInputAnswers(pending.questions, drafts) : null;

  const report = (
    result: { _tag: "Success" } | { _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
    title: string,
  ) => {
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Try again from the thread.",
        ),
      });
      return false;
    }
    return true;
  };

  const sendAnswers = async () => {
    if (!pending || !answers) return;
    setBusy(true);
    const result = await respond({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, requestId: pending.requestId, answers },
    });
    setBusy(false);
    if (report(result, "Could not send the answers")) setDrafts({});
  };

  const sendReply = async () => {
    const text = reply.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    const result = await startTurn({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: task.thread.runtimeMode,
        interactionMode: task.thread.interactionMode,
      },
    });
    setBusy(false);
    if (report(result, "Could not send the reply")) setReply("");
  };

  const openThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  const working =
    task.thread.session?.status === "running" || task.thread.session?.status === "starting";

  return (
    <section className="ms-6 flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{task.thread.title}</h2>
        <Button size="xs" variant="outline" onClick={openThread}>
          <ExternalLinkIcon aria-hidden className="size-3.5" />
          Open thread
        </Button>
      </div>
      {approvals.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          The agent waits for an approval. Open the thread to answer it.
        </p>
      ) : null}
      {pending ? (
        <>
          {pending.questions.map((question) => {
            const selected = drafts[question.id]?.selectedOptionValues ?? [];
            return (
              <div key={question.id} className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">{question.header}</p>
                <p className="text-sm">{question.question}</p>
                <div className="flex flex-wrap gap-1.5">
                  {question.options.map((option) => {
                    const value = option.value ?? option.label;
                    return (
                      <Button
                        key={value}
                        size="xs"
                        variant={selected.includes(value) ? "default" : "outline"}
                        aria-pressed={selected.includes(value)}
                        disabled={busy}
                        title={option.description}
                        onClick={() =>
                          setDrafts((current) => ({
                            ...current,
                            [question.id]: togglePendingUserInputOptionSelection(
                              question,
                              current[question.id],
                              value,
                            ),
                          }))
                        }
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button
              size="xs"
              disabled={busy || answers === null}
              onClick={() => void sendAnswers()}
            >
              {pending.questions.length === 1 ? "Send answer" : "Send answers"}
            </Button>
          </div>
        </>
      ) : latestReply ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            {working ? "Agent is working. Last reply:" : "Last reply from the agent:"}
          </p>
          <p className="line-clamp-6 whitespace-pre-wrap text-sm">{latestReply.text}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {working ? "The agent is working." : "No question is open."}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendReply();
            }
          }}
          placeholder="Reply to the agent. Enter sends, Shift+Enter adds a line."
          rows={3}
          disabled={busy}
        />
        <div className="flex justify-end">
          <Button
            size="xs"
            disabled={busy || reply.trim().length === 0}
            onClick={() => void sendReply()}
          >
            {busy ? "Sending..." : "Send"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** One field, or the issue picker. The project comes from the input when it can. */
function StartTaskForm() {
  const projects = useProjects();
  const environmentId = usePrimaryEnvironmentId();
  const startTask = useStartFactoryTask();
  const [text, setText] = useState("");
  const [chosenProjectKey, setChosenProjectKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const input = useMemo(() => classifyFactoryInput(text), [text]);
  const resolution = useMemo(
    () => (input ? resolveFactoryProject(input, projects) : null),
    [input, projects],
  );
  const candidates: ReadonlyArray<EnvironmentProject> =
    resolution?.kind === "ask" ? resolution.candidates : [];
  const project: EnvironmentProject | null =
    resolution?.kind === "resolved"
      ? resolution.project
      : (candidates.find((candidate) => projectKey(candidate) === chosenProjectKey) ?? null);

  const start = async (input: FactoryInput, project: EnvironmentProject) => {
    setStarting(true);
    const result = await startTask(input, project);
    setStarting(false);
    if (!result.ok) {
      toastManager.add({ type: "error", title: result.title, description: result.detail });
      return;
    }
    setText("");
    setChosenProjectKey(null);
    toastManager.add({ type: "success", title: "Factory task started" });
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Start a task</h2>
        {environmentId !== null ? (
          <Button size="xs" variant="outline" onClick={() => setPickerOpen(true)}>
            <CircleDotIcon aria-hidden className="size-3.5" />
            From issues
          </Button>
        ) : null}
      </div>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="GitHub issue URL, Notion page URL, or describe the task"
        rows={3}
        disabled={starting}
      />
      <div className="flex flex-wrap items-center gap-2">
        {input ? <Badge variant="secondary">{INPUT_KIND_LABELS[input.kind]}</Badge> : null}
        {resolution?.kind === "resolved" ? (
          <span className="text-xs text-muted-foreground">Project: {resolution.project.title}</span>
        ) : null}
        {resolution?.kind === "ask" ? (
          <Select value={chosenProjectKey} onValueChange={(value) => setChosenProjectKey(value)}>
            <SelectTrigger size="sm" aria-label="Project">
              <SelectValue placeholder="Pick the project">
                {(value: string | null) =>
                  candidates.find((candidate) => projectKey(candidate) === value)?.title ??
                  "Pick the project"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((candidate) => (
                <SelectItem key={projectKey(candidate)} value={projectKey(candidate)}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={starting || !input || !project}
          onClick={() => {
            if (input && project) void start(input, project);
          }}
        >
          <PlayIcon aria-hidden className="size-3.5" />
          {starting ? "Starting..." : "Run the code-factory"}
        </Button>
      </div>
      {environmentId !== null ? (
        <FactoryIssuePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          environmentId={environmentId}
        />
      ) : null}
    </section>
  );
}

const INPUT_KIND_LABELS: Record<FactoryInput["kind"], ReactNode> = {
  "github-issue": "GitHub issue",
  "notion-page": "Notion page",
  "free-text": "Free text",
  "pull-request": "Pull request",
};

function projectKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.id}`;
}
