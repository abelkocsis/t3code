/**
 * To-do list right-panel surface.
 *
 * The list belongs to the environment, not to the thread it is opened from, so
 * it reads the same on every thread and on every device connected to the same
 * server.
 *
 * The order is the priority: the user drags the next thing to the top. Ticking
 * an item off moves it to a Done section rather than deleting it, so a
 * mis-click costs one click back.
 */
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentId, TodoItem } from "@t3tools/contracts";
import { Check, GripVertical, Plus, Undo2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { useTodos } from "~/state/todos";

export function TodoPanel({ environmentId }: { environmentId: EnvironmentId | null }) {
  const todos = useTodos(environmentId);
  const [draft, setDraft] = useState("");

  // A short distance keeps a plain click on the handle from starting a drag,
  // and keeps the item text selectable.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const openIds = useMemo(() => todos.open.map((item) => item.itemId), [todos.open]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const from = todos.open.findIndex((item) => item.itemId === active.id);
      const to = todos.open.findIndex((item) => item.itemId === over.id);
      if (from === -1 || to === -1) return;
      const next = [...todos.open];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      void todos.reorderOpen(next);
    },
    [todos],
  );

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px p-2">
          {todos.error !== null ? (
            <p className="px-1 py-2 text-destructive text-sm">{todos.error}</p>
          ) : null}

          {todos.open.length === 0 && todos.done.length === 0 && !todos.isLoading ? (
            <p className="px-1 py-2 text-muted-foreground text-sm">
              Nothing on the list. Type the next thing below.
            </p>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={openIds} strategy={verticalListSortingStrategy}>
              {todos.open.map((item) => (
                <TodoRow
                  key={item.itemId}
                  item={item}
                  onToggle={() => void todos.setItemDone(item.itemId, true)}
                  onEdit={(text) => void todos.editItem(item.itemId, text)}
                  onRemove={() => void todos.removeItem(item.itemId)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {todos.done.length > 0 ? (
            <div className="mt-3 flex items-center justify-between gap-2 px-1">
              <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Done
              </span>
              <Button variant="ghost" size="sm" onClick={() => void todos.clearDone()}>
                Clear done
              </Button>
            </div>
          ) : null}

          {todos.done.map((item) => (
            <TodoRow
              key={item.itemId}
              item={item}
              onToggle={() => void todos.setItemDone(item.itemId, false)}
              onEdit={(text) => void todos.editItem(item.itemId, text)}
              onRemove={() => void todos.removeItem(item.itemId)}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 flex-col gap-2 border-t p-2">
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void todos.addItem(draft);
            setDraft("");
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1"
            placeholder="Add a to-do"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add this to-do">
            <Plus className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * One to-do.
 *
 * The text is editable in place, because a to-do is usually retyped rather
 * than deleted and written again. The grip and the delete button stay hidden
 * until the row is hovered, so the resting list reads as plain text.
 */
function TodoRow({
  item,
  onToggle,
  onEdit,
  onRemove,
}: {
  item: TodoItem;
  onToggle: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.itemId,
    disabled: item.done,
  });
  const [draft, setDraft] = useState<string | null>(null);

  const commit = useCallback(() => {
    if (draft !== null && draft.trim() !== item.text) onEdit(draft);
    setDraft(null);
  }, [draft, item.text, onEdit]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex items-start gap-1 rounded-md px-1 py-1 hover:bg-muted/50",
        isDragging && "z-10 bg-muted shadow-sm",
      )}
    >
      <button
        type="button"
        className={cn(
          "mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
          "group-hover:opacity-100 focus-visible:opacity-100",
          item.done && "invisible",
          isDragging && "cursor-grabbing opacity-100",
        )}
        aria-label="Reorder this to-do"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={item.done ? "Put this to-do back" : "Mark this to-do done"}
        onClick={onToggle}
      >
        {item.done ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
      </Button>
      {draft === null ? (
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 cursor-text text-left text-sm leading-relaxed",
            item.done && "text-muted-foreground line-through",
          )}
          onClick={() => setDraft(item.text)}
        >
          {item.text}
        </button>
      ) : (
        <input
          autoFocus
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm leading-relaxed outline-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Delete this to-do"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
