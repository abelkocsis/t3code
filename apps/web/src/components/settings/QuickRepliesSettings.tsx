import { DEFAULT_QUICK_REPLIES, type QuickReply } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
        other.text === reply.text
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
    setDraft(null);
    // An empty label or text cannot be decoded, and a half-typed row is not a
    // reason to reject the rest of the edit.
    const usable = next.filter((reply) => reply.label.trim() !== "" && reply.text.trim() !== "");
    if (sameReplies(usable, replies)) return;
    updateSettings({ quickReplies: usable });
  };

  const editRow = (id: string, patch: Partial<QuickReply>) => {
    setDraft(rows.map((reply) => (reply.id === id ? { ...reply, ...patch } : reply)));
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["quickReplies"]}
      {...searchableSetting("quick-replies")}
      description="One tap sends the reply. Shift-click puts it in the composer instead. The chips show while the draft is empty."
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
        {rows.map((reply) => (
          <div key={reply.id} className="flex items-center gap-1.5">
            <div className="w-32 flex-none rounded-lg border border-border bg-input">
              <Input
                size="sm"
                aria-label="Chip label"
                placeholder="Chip"
                value={reply.label}
                onChange={(event) => editRow(reply.id, { label: event.target.value })}
                onBlur={() => commit(rows)}
              />
            </div>
            <div className="min-w-0 flex-1 rounded-lg border border-border bg-input">
              <Input
                size="sm"
                aria-label="Message sent"
                placeholder="Message the agent receives"
                value={reply.text}
                onChange={(event) => editRow(reply.id, { text: event.target.value })}
                onBlur={() => commit(rows)}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${reply.label || "reply"}`}
              onClick={() => commit(rows.filter((candidate) => candidate.id !== reply.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
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
