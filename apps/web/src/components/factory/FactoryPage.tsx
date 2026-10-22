import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  classifyFactoryInput,
  DEFAULT_SERVER_SETTINGS,
  FACTORY_BLOCKED_SNOOZE_MS,
  FACTORY_COMPLETED_PHASES,
  FACTORY_PHASE_LABELS,
  FACTORY_PHASE_MARKER,
  FACTORY_PHASES,
  FACTORY_REVIEW_PHASES,
  factoryHeldWorkMessage,
  type FactoryInput,
  type FactoryPhase,
  type ModelSelection,
  type PullRequestMergeMethod,
  type ThreadFactory,
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
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  EyeIcon,
  FolderIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  MilestoneIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { observeResize } from "../../lib/observeResize";

import { isElectron } from "../../env";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useFactoryFolders } from "../../hooks/useFactoryFolders";
import { useFactoryTokenSaving } from "../../hooks/useFactoryTokenSaving";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn, newMessageId } from "../../lib/utils";
import {
  resolvePendingUserInputAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useForkThreadStates, useSetThreadFactory } from "../../state/fork";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  readableFailure,
} from "../pullRequest/pullRequestDetail.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildReviewRequestMessage,
  collectFactoryTasks,
  FACTORY_PROGRESS_STAGES,
  FACTORY_TASK_STATE_LABELS,
  factoryProgress,
  factoryTaskKey,
  formatElapsed,
  isFactoryAgentRunning,
  isReReviewRequest,
  orderFactoryTasks,
  resolveFactoryProject,
  type FactoryTask,
  type FactoryTaskState,
} from "./factory.logic";
import { TaskModelPicker } from "./TaskModelPicker";
import { useFactoryMembership } from "./useFactoryMembership";
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

/** Ready for review sends the first request; under review nudges the reviewers again. */
function canRequestReview(task: FactoryTask): boolean {
  return task.factory.phase === "ready-for-review" || task.factory.phase === "under-review";
}

/** The task state folded to a dot; the word lives in its tooltip. */
const STATE_DOT: Record<FactoryTaskState, string> = {
  waiting: "bg-warning",
  working: "bg-info",
  idle: "bg-muted-foreground/40",
  snoozed: "bg-muted-foreground/40",
  error: "bg-destructive",
  done: "bg-success",
};

/** Below this, the title column is too narrow to read, so the row folds its next label. */
const TITLE_MIN_WIDTH = 200;
/** How far the row must grow past the width where a label folded before it unfolds again. */
const UNFOLD_SLACK = 24;

/**
 * How many labels a task row folds into icons, in order: the phase, the review buttons, then
 * the state. Folds one more while the title column is too narrow, and unfolds once the row is
 * wider than where that label folded. Starts over when the row's content changes.
 */
function useRowFoldLevel(
  row: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  contentKey: string,
): number {
  const [fold, setFold] = useState({ key: contentKey, level: 0 });
  useLayoutEffect(() => {
    const rowElement = row.current;
    const titleElement = title.current;
    if (!rowElement || !titleElement) return;
    let level = 0;
    const foldedAt: number[] = [];
    const check = () => {
      const rowWidth = rowElement.clientWidth;
      let next = level;
      if (titleElement.clientWidth < TITLE_MIN_WIDTH && level < 3) {
        foldedAt[level] = rowWidth;
        next = level + 1;
      } else if (level > 0 && rowWidth > (foldedAt[level - 1] ?? 0) + UNFOLD_SLACK) {
        next = level - 1;
      }
      if (next === level) return;
      level = next;
      setFold({ key: contentKey, level });
    };
    return observeResize([rowElement, titleElement], check);
  }, [row, title, contentKey]);
  return fold.key === contentKey ? fold.level : 0;
}

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
 * folders and the tasks: a task dropped on a folder or on one of its rows files it there.
 */
export function FactoryPage() {
  useEscapeToGoBack();
  const navigate = useNavigate();
  const threads = useThreadShells();
  const states = useForkThreadStates();
  const folders = useFactoryFolders();
  const setFactory = useSetThreadFactory();
  const order = useUiStateStore((state) => state.factoryTaskOrder);
  const setOrder = useUiStateStore((state) => state.setFactoryTaskOrder);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const tasks = orderFactoryTasks(collectFactoryTasks(threads, states, now), order);
  const active = tasks.filter((task) => task.state !== "done");
  const completed = tasks.filter((task) => task.state === "done");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Tasks ticked for one combined review request.
  const [checkedKeys, setCheckedKeys] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const [folderDialog, setFolderDialog] = useState<
    | { readonly mode: "create" }
    | { readonly mode: "rename"; readonly id: string; readonly name: string }
    | null
  >(null);
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
  // A short distance keeps a plain click on the handle from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const folderIds = new Set(folders.folders.map((folder) => folder.id));
  const storedLayout = new Map<string | null, FactoryTask[]>();
  for (const task of active) {
    // A task whose folder was deleted sits below the folders again.
    const id =
      task.factory.folderId && folderIds.has(task.factory.folderId) ? task.factory.folderId : null;
    storedLayout.set(id, [...(storedLayout.get(id) ?? []), task]);
  }
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
    const result = await setFactory(task.thread.environmentId, task.thread.id, {
      ...task.factory,
      folderId,
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

  const renderRow = (task: FactoryTask) => {
    const key = factoryTaskKey(task);
    const selected = selectedKey === key;
    return (
      <div key={key} className="flex flex-col gap-2">
        <TaskRow
          task={task}
          now={now}
          selected={selected}
          checked={canRequestReview(task) ? checkedKeys.has(key) : null}
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
    (task) => canRequestReview(task) && checkedKeys.has(factoryTaskKey(task)),
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
            <TokenSavingSwitch />
            {folders.supported ? (
              <Button size="xs" variant="ghost" onClick={() => setFolderDialog({ mode: "create" })}>
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
                        onRename={() =>
                          setFolderDialog({ mode: "rename", id: folder.id, name: folder.name })
                        }
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
      <FolderNameDialog
        request={folderDialog}
        takenNames={folders.folders
          .filter((folder) => folderDialog?.mode !== "rename" || folder.id !== folderDialog.id)
          .map((folder) => folder.name)}
        onClose={() => setFolderDialog(null)}
        onSubmit={(name) => {
          if (folderDialog?.mode === "rename") {
            if (name !== folderDialog.name) void folders.renameFolder(folderDialog.id, name);
          } else {
            void folders.createFolder(name);
          }
          setFolderDialog(null);
        }}
      />
    </SidebarInset>
  );
}

/** Asks for a folder name. A name another folder already has is refused. */
function FolderNameDialog({
  request,
  takenNames,
  onClose,
  onSubmit,
}: {
  request: { readonly mode: "create" } | { readonly mode: "rename"; readonly name: string } | null;
  takenNames: ReadonlyArray<string>;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [seededFor, setSeededFor] = useState<typeof request>(null);
  if (request !== seededFor) {
    setSeededFor(request);
    setName(request?.mode === "rename" ? request.name : "");
  }
  const trimmed = name.trim();
  const taken = takenNames.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  const canSubmit = trimmed.length > 0 && !taken;
  const submit = () => {
    if (canSubmit) onSubmit(trimmed);
  };
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => (!open ? onClose() : null)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request?.mode === "rename" ? "Rename folder" : "New folder"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {request?.mode === "rename"
              ? "The tasks inside keep their place."
              : "Group factory tasks under one heading."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          autoFocus
          value={name}
          aria-label="Folder name"
          aria-invalid={taken}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        {taken ? (
          <p className="text-xs text-destructive">A folder with this name already exists.</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            {request?.mode === "rename" ? "Rename" : "Create"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
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
  /** Null hides the box: only tasks that can ask for review join a combined request. */
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
  // The full title shows on hover only when the row cuts it short.
  const titleRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const titleColumnRef = useRef<HTMLDivElement>(null);
  const foldLevel = useRowFoldLevel(rowRef, titleColumnRef, `${task.factory.phase}:${task.state}`);
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false);

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
      ref={(element) => {
        setNodeRef(element);
        rowRef.current = element;
      }}
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
        "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
      <div ref={titleColumnRef} className="flex min-w-36 flex-1 flex-col">
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
            <Tooltip
              open={titleTooltipOpen}
              onOpenChange={(open) => {
                const title = titleRef.current;
                setTitleTooltipOpen(
                  open && title !== null && title.scrollWidth > title.clientWidth,
                );
              }}
            >
              <TooltipTrigger
                render={
                  <button
                    ref={titleRef}
                    type="button"
                    className="truncate text-start text-sm text-foreground hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen();
                    }}
                  />
                }
              >
                {task.thread.title}
              </TooltipTrigger>
              <TooltipPopup>{task.thread.title}</TooltipPopup>
            </Tooltip>
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
        <TaskProgress task={task} />
      </div>
      {(task.factory.reviewRound ?? 0) > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {task.factory.reviewRound === 1
            ? "1 review round"
            : `${task.factory.reviewRound} review rounds`}
        </span>
      ) : null}
      <span
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
        aria-label="Time in this stage"
      >
        {formatElapsed(task.factory.updatedAt, now)}
      </span>
      {foldLevel >= 1 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={FACTORY_PHASE_LABELS[task.factory.phase]}
                className="flex shrink-0 text-muted-foreground"
              />
            }
          >
            <MilestoneIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{FACTORY_PHASE_LABELS[task.factory.phase]}</TooltipPopup>
        </Tooltip>
      ) : (
        <Badge variant="outline">{FACTORY_PHASE_LABELS[task.factory.phase]}</Badge>
      )}
      {foldLevel >= 3 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={FACTORY_TASK_STATE_LABELS[task.state]}
                className={cn("size-2 shrink-0 rounded-full", STATE_DOT[task.state])}
              />
            }
          />
          <TooltipPopup>{FACTORY_TASK_STATE_LABELS[task.state]}</TooltipPopup>
        </Tooltip>
      ) : (
        <Badge variant={STATE_BADGE[task.state]}>{FACTORY_TASK_STATE_LABELS[task.state]}</Badge>
      )}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <StartWorkButton task={task} />
        <ReviewActions task={task} compact={foldLevel >= 2} />
        {task.pullRequest ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Open pull request #${task.pullRequest.number}`}
                  onClick={openPullRequest}
                />
              }
            >
              <PullRequestGlyph.pullRequest aria-hidden className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Pull request #{task.pullRequest.number}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label="Open as thread" onClick={onOpen} />
            }
          >
            <MessageSquareIcon aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>Open the task as a chat thread</TooltipPopup>
        </Tooltip>
        <TaskMenu task={task} />
      </div>
    </div>
  );
}

/**
 * One segment per stage on a fixed width, so the end of the track always shows. Done stages
 * are grey and the current one is tinted. A human gate turns the current segment amber, or
 * the whole bar when the gate predates the stored stage. Colors ease once per change and never
 * animate on their own.
 */
function TaskProgress({ task }: { task: FactoryTask }) {
  const { stage, gated, complete } = factoryProgress(task);
  const label =
    stage === null
      ? "Waiting on you"
      : `${FACTORY_PROGRESS_STAGES[stage]}, stage ${stage + 1} of ${FACTORY_PROGRESS_STAGES.length}${gated ? ", waiting on you" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<div className="mt-1.5 flex w-36 gap-0.5" role="img" aria-label={label} />}
      >
        {FACTORY_PROGRESS_STAGES.map((name, index) => (
          <span
            key={name}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-500",
              stage === null
                ? "bg-warning/30"
                : index < stage || complete
                  ? "bg-foreground/35"
                  : index === stage
                    ? gated
                      ? "bg-warning/80"
                      : "bg-primary/70"
                    : "bg-foreground/10",
            )}
          />
        ))}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A wake time far enough ahead that only the merge check or the user ends the sleep. */
function blockedSnoozeUntil(): string {
  return new Date(Date.now() + FACTORY_BLOCKED_SNOOZE_MS).toISOString();
}

/** Snooze, wake, set phase, remove, and archive live behind one button so the row stays readable. */
function TaskMenu({ task }: { task: FactoryTask }) {
  const { archiveThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const { removeFromFactory } = useFactoryMembership();
  const setFactory = useSetThreadFactory();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const ref = scopeThreadRef(task.thread.environmentId, task.thread.id);
  const presets = resolveSnoozePresets(new Date(), timestampFormat);
  const blockedBy = task.factory.blockedBy ?? null;

  const report = (ok: boolean, title: string) => {
    if (!ok) toastManager.add({ type: "error", title });
  };
  const update = (factory: ThreadFactory) => setFactory(ref.environmentId, ref.threadId, factory);
  const snoozeUntil = async (snoozedUntil: string) => {
    const result = await snoozeThread(ref, snoozedUntil);
    report(result._tag === "Success", "Could not snooze the task");
  };
  const wake = async () => {
    if (blockedBy) await update({ ...task.factory, blockedBy: null });
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
    const flagged = await update({
      ...task.factory,
      blockedBy: {
        url,
        host: parsed.host,
        repository: parsed.repository,
        number: parsed.number,
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
  // Moves the task by hand when the agent lost track of it. The agent owns the phases up to
  // "done", so those also get a message telling it where to pick up; the review phases and
  // the finished ones are the server's and the human's, so the label alone is the change.
  const setPhase = async (phase: FactoryPhase) => {
    const result = await update({
      ...task.factory,
      phase,
      summary: "Set by hand.",
      updatedAt: new Date().toISOString(),
    });
    if (result._tag === "Failure") {
      report(false, "Could not change the phase");
      return;
    }
    if (FACTORY_REVIEW_PHASES.includes(phase) || FACTORY_COMPLETED_PHASES.includes(phase)) return;
    const sent = await startTurn({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: `I moved this task to the "${FACTORY_PHASE_LABELS[phase]}" phase by hand. Continue the code-factory flow from there. Print "${FACTORY_PHASE_MARKER} ${phase}" first.`,
          attachments: [],
        },
        runtimeMode: task.thread.runtimeMode,
        interactionMode: task.thread.interactionMode,
      },
    });
    report(sent._tag === "Success", "Phase changed, but the agent could not be told");
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
          <MenuSub>
            <MenuSubTrigger>
              <PlayIcon aria-hidden className="size-3.5" />
              Set phase
            </MenuSubTrigger>
            <MenuSubPopup>
              {/* "Done" is left out: the agent prints it when the flow ends, and the server
                  moves the task on from there. Merged is the way to close a task by hand. */}
              {FACTORY_PHASES.filter((phase) => phase !== "done").map((phase) => (
                <MenuItem
                  key={phase}
                  disabled={phase === task.factory.phase}
                  onClick={() => void setPhase(phase)}
                >
                  {FACTORY_PHASE_LABELS[phase]}
                  {phase === task.factory.phase ? (
                    <CheckIcon aria-hidden className="ms-auto size-3.5 ps-2" />
                  ) : null}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem onClick={() => void removeFromFactory(task.thread, task.factory)}>
            <MessageSquareIcon aria-hidden className="size-3.5" />
            Remove from Factory, keep thread
          </MenuItem>
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

/** Token saving on every task: the server watches pull requests but starts no work. */
function TokenSavingSwitch() {
  const tokenSaving = useFactoryTokenSaving();
  if (!tokenSaving.supported) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground [-webkit-app-region:no-drag]" />
        }
      >
        <Switch
          checked={tokenSaving.enabled}
          onCheckedChange={(checked) =>
            void tokenSaving
              .setEnabled(Boolean(checked))
              .catch(() =>
                toastManager.add({ type: "error", title: "Could not change token saving" }),
              )
          }
        />
        Token saving
      </TooltipTrigger>
      <TooltipPopup>
        Pull requests and CI are still watched. CI fixes, review replies, and rebases wait for you
        to start them.
      </TooltipPopup>
    </Tooltip>
  );
}

/** Starts review work the server held back because token saving is on. */
function StartWorkButton({ task }: { task: FactoryTask }) {
  const setFactory = useSetThreadFactory();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const pending = task.factory.pendingWork ?? null;
  if (pending === null) return null;

  const start = async () => {
    setBusy(true);
    const flagged = await setFactory(task.thread.environmentId, task.thread.id, {
      ...task.factory,
      phase: "fix",
      summary: pending.summary,
      updatedAt: new Date().toISOString(),
      pendingWork: null,
    });
    if (flagged._tag === "Failure") {
      setBusy(false);
      toastManager.add({ type: "error", title: "Could not start the work" });
      return;
    }
    const sent = await startTurn({
      environmentId: task.thread.environmentId,
      input: {
        threadId: task.thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: factoryHeldWorkMessage(pending),
          attachments: [],
        },
        runtimeMode: task.thread.runtimeMode,
        interactionMode: task.thread.interactionMode,
      },
    });
    setBusy(false);
    if (sent._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not send the work to the agent" });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="xs" disabled={busy} onClick={() => void start()} />}>
        <PlayIcon aria-hidden className="size-3.5" />
        Start work
      </TooltipTrigger>
      <TooltipPopup>{pending.summary}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * What the human does at each review stage. Ready for review: copy the request and mark the
 * task under review. Under review: copy the same request again to nudge reviewers. Ready to
 * merge: merge. The server moves the task between the stages.
 */
function ReviewActions({ task, compact }: { task: FactoryTask; compact: boolean }) {
  const setFactory = useSetThreadFactory();
  const phase = task.factory.phase;
  const pullRequest = task.pullRequest;
  if (!pullRequest) return null;

  const markUnderReview = async () => {
    const now = new Date().toISOString();
    const snapshot = pullRequest.snapshot;
    const result = await setFactory(task.thread.environmentId, task.thread.id, {
      ...task.factory,
      phase: "under-review",
      summary: "Waiting on reviewers.",
      updatedAt: now,
      reviewRound: (task.factory.reviewRound ?? 0) + 1,
      // Checks start from what the pull request shows now. The base state starts unseen, so a
      // branch that is already behind gets its rebase. Open threads, reviews, and comments
      // keep what the agent was already sent; a first round starts from nothing, so every
      // review already there goes to the agent, and a later round leaves the ids out so the
      // server counts the current ones as sent once it reads them.
      review: {
        seenUpdatedAt: snapshot?.updatedAt ?? null,
        seenUnresolved: task.factory.review?.seenUnresolved ?? 0,
        seenChecksState: snapshot?.checksState ?? null,
        seenMergeState: null,
        ...(task.factory.review?.seenReviewId !== undefined
          ? { seenReviewId: task.factory.review.seenReviewId }
          : (task.factory.reviewRound ?? 0) === 0
            ? { seenReviewId: null }
            : {}),
        ...(task.factory.review?.seenCommentId !== undefined
          ? { seenCommentId: task.factory.review.seenCommentId }
          : (task.factory.reviewRound ?? 0) === 0
            ? { seenCommentId: null }
            : {}),
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not mark the task under review" });
    }
  };

  const reReview = isReReviewRequest([task]);
  const copyRequest = async () => {
    try {
      await writeTextToClipboard(
        buildReviewRequestMessage([pullRequest.url], { reReview }),
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

  const copyLabel = reReview ? "Copy re-review request" : "Copy review request";
  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={copyLabel}
            onClick={() => void copyRequest()}
          />
        }
      >
        <CopyIcon aria-hidden className="size-3.5" />
        {compact ? null : copyLabel}
      </TooltipTrigger>
      <TooltipPopup>{copyLabel} for the reviewers</TooltipPopup>
    </Tooltip>
  );

  if (phase === "ready-for-review") {
    return (
      <>
        {copyButton}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                aria-label="Mark under review"
                onClick={() => void markUnderReview()}
              />
            }
          >
            {compact ? <EyeIcon aria-hidden className="size-3.5" /> : "Mark under review"}
          </TooltipTrigger>
          <TooltipPopup>
            Mark under review: the agent reads the reviews and answers new ones
          </TooltipPopup>
        </Tooltip>
      </>
    );
  }
  if (phase === "under-review") return copyButton;
  if (phase === "ready-to-merge") {
    return <MergeButton task={task} />;
  }
  return null;
}

/** One review request for every ticked task. */
function CombinedReviewRequest({
  tasks,
  onDone,
}: {
  tasks: ReadonlyArray<FactoryTask>;
  onDone: () => void;
}) {
  const urls = tasks.flatMap((task) => (task.pullRequest ? [task.pullRequest.url] : []));
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
    <Button size="xs" variant="outline" onClick={() => void copy()}>
      <CopyIcon aria-hidden className="size-3.5" />
      Copy review request for {urls.length}
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

/** One answer per question, or null while a question is still open. */
function collectAnswers(
  questions: ReadonlyArray<Parameters<typeof resolvePendingUserInputAnswer>[0]>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, drafts[question.id]);
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

/**
 * The question the agent asked, with its options, the agent's latest reply, and a reply box.
 * Approvals need the full thread, so they only link there.
 */
function GatePanel({ task }: { task: FactoryTask }) {
  const navigate = useNavigate();
  const ref = scopeThreadRef(task.thread.environmentId, task.thread.id);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const { approvals, userInputs } = projection
    ? derivePendingThreadRequests(projection)
    : { approvals: [], userInputs: [] };
  const latestReply =
    projection?.messages.findLast((message) => message.role === "assistant") ?? null;
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const pending = userInputs[0] ?? null;
  // One request carries several questions; the answer goes out once every question has one.
  const answers = pending ? collectAnswers(pending.questions, drafts) : null;

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
  const working = isFactoryAgentRunning(task.thread);

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

// The unsent form outlives navigation away from the page, but not a reload.
let startTaskDraft: {
  text: string;
  chosenProjectKey: string | null;
  modelSelection: ModelSelection | null;
} = { text: "", chosenProjectKey: null, modelSelection: null };

/** One field for an issue link, a pull request link, or free text. The project comes from the input when it can. */
function StartTaskForm() {
  const projects = useProjects();
  const environmentId = usePrimaryEnvironmentId();
  const startTask = useStartFactoryTask();
  const [text, setText] = useState(startTaskDraft.text);
  const [chosenProjectKey, setChosenProjectKey] = useState(startTaskDraft.chosenProjectKey);
  const [starting, setStarting] = useState(false);
  const [modelSelection, setModelSelection] = useState(startTaskDraft.modelSelection);

  useEffect(() => {
    startTaskDraft = { text, chosenProjectKey, modelSelection };
  }, [text, chosenProjectKey, modelSelection]);

  const input = classifyFactoryInput(text);
  const resolution = input ? resolveFactoryProject(input, projects) : null;
  const candidates: ReadonlyArray<EnvironmentProject> =
    resolution?.kind === "ask" ? resolution.candidates : [];
  const project: EnvironmentProject | null =
    resolution?.kind === "resolved"
      ? resolution.project
      : (candidates.find((candidate) => projectKey(candidate) === chosenProjectKey) ?? null);

  const start = async (input: FactoryInput, project: EnvironmentProject) => {
    setStarting(true);
    const result = await startTask(input, project, { modelSelection });
    setStarting(false);
    if (!result.ok) {
      toastManager.add({
        type: "error",
        title: result.title,
        ...(result.detail === undefined ? {} : { description: result.detail }),
      });
      return;
    }
    setText("");
    setChosenProjectKey(null);
    toastManager.add({ type: "success", title: "Factory task started" });
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Start a task</h2>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="GitHub issue URL, pull request URL, or describe the task"
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
        {(project?.environmentId ?? environmentId) !== null ? (
          <TaskModelPicker
            environmentId={(project?.environmentId ?? environmentId)!}
            project={project}
            value={modelSelection}
            onChange={setModelSelection}
          />
        ) : null}
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
