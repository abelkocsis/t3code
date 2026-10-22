import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DEFAULT_QUICK_REPLIES, type QuickReply } from "@t3tools/contracts";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function sameReplies(left: ReadonlyArray<QuickReply>, right: ReadonlyArray<QuickReply>): boolean {
  return (
    left.length === right.length &&
    left.every((reply, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.id === reply.id &&
        other.label === reply.label &&
        other.text === reply.text &&
        (other.showInNewThread === true) === (reply.showInNewThread === true)
      );
    })
  );
}

/**
 * Edits the chips the composer offers while a draft is empty.
 *
 * Each row commits on blur rather than on every keystroke: the list travels to
 * the server whole, and saving per character would send one settings write per
 * letter typed.
 */
export function QuickRepliesSettings() {
  const replies = useScopedSettings((settings) => settings.quickReplies);
  const updateSettings = useUpdateScopedSettings();
  const [draft, setDraft] = useState<ReadonlyArray<QuickReply> | null>(null);
  const rows = draft ?? replies;

  const commit = (next: ReadonlyArray<QuickReply>) => {
    // An empty label or text cannot be decoded, and a half-typed row is not a
    // reason to reject the rest of the edit. The half-typed row stays in the
    // draft so moving between its two fields does not erase it.
    const usable = next.filter((reply) => reply.label.trim() !== "" && reply.text.trim() !== "");
    setDraft(sameReplies(usable, next) ? null : next);
    if (sameReplies(usable, replies)) return;
    updateSettings({ quickReplies: usable });
  };

  const editRow = (id: string, patch: Partial<QuickReply>) => {
    setDraft(rows.map((reply) => (reply.id === id ? { ...reply, ...patch } : reply)));
  };

  // A short distance keeps a plain click on the grip from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = rows.findIndex((reply) => reply.id === active.id);
    const to = rows.findIndex((reply) => reply.id === over.id);
    if (from === -1 || to === -1) return;
    commit(arrayMove([...rows], from, to));
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["quickReplies"]}
      {...searchableSetting("quick-replies")}
      description="One tap sends the reply. Shift-click puts it in the composer instead. The chips show while the draft is empty. A ticked reply also shows on a new thread. Drag the grip to change the chip order."
      resetAction={
        sameReplies(replies, DEFAULT_QUICK_REPLIES) ? null : (
          <SettingResetButton
            label="quick replies"
            onClick={() => {
              setDraft(null);
              updateSettings({ quickReplies: DEFAULT_QUICK_REPLIES });
            }}
          />
        )
      }
    >
      <div className="flex flex-col gap-1.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={rows.map((reply) => reply.id)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((reply) => (
              <QuickReplyRow
                key={reply.id}
                reply={reply}
                onEdit={(patch) => editRow(reply.id, patch)}
                onBlur={() => commit(rows)}
                onShowInNewThreadChange={(showInNewThread) =>
                  commit(
                    rows.map((candidate) =>
                      candidate.id === reply.id ? { ...candidate, showInNewThread } : candidate,
                    ),
                  )
                }
                onRemove={() => commit(rows.filter((candidate) => candidate.id !== reply.id))}
              />
            ))}
          </SortableContext>
        </DndContext>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft([...rows, { id: randomUUID(), label: "", text: "" }])}
          >
            <PlusIcon />
            Add reply
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}

/** One editable reply. The grip drags the row to set the chip order. */
function QuickReplyRow({
  reply,
  onEdit,
  onBlur,
  onShowInNewThreadChange,
  onRemove,
}: {
  reply: QuickReply;
  onEdit: (patch: Partial<QuickReply>) => void;
  onBlur: () => void;
  onShowInNewThreadChange: (showInNewThread: boolean) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: reply.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-start gap-1.5 rounded-lg",
        isDragging && "relative z-10 bg-background shadow-sm",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex h-8 flex-none cursor-grab items-center text-muted-foreground sm:h-7",
          isDragging && "cursor-grabbing",
        )}
        aria-label={`Reorder ${reply.label || "reply"}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <div className="w-32 flex-none rounded-lg border border-border bg-input">
        <Input
          size="sm"
          aria-label="Chip label"
          placeholder="Chip"
          value={reply.label}
          onChange={(event) => onEdit({ label: event.target.value })}
          onBlur={onBlur}
        />
      </div>
      <Textarea
        size="sm"
        compact
        rows={1}
        aria-label="Message sent"
        placeholder="Message the agent receives"
        value={reply.text}
        onChange={(event) => onEdit({ text: event.target.value })}
        onBlur={onBlur}
      />
      <div className="flex h-8 flex-none items-center sm:h-7">
        <Checkbox
          aria-label={`Show ${reply.label || "reply"} on new threads`}
          title="Show on new threads"
          checked={reply.showInNewThread === true}
          onCheckedChange={(checked) => onShowInNewThreadChange(checked === true)}
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${reply.label || "reply"}`}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
