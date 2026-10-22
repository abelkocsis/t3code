import type { QuickReply } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

/**
 * The saved replies, offered while the draft is empty.
 *
 * A click sends the reply's text at once, which is the point: these are the
 * answers that get typed over and over once an agent stops. Shift-click puts
 * the text in the composer instead, for the times the reply needs a sentence
 * added to it.
 */
export const ComposerQuickReplies = memo(function ComposerQuickReplies({
  replies,
  onSelect,
}: {
  replies: ReadonlyArray<QuickReply>;
  onSelect: (reply: QuickReply, insertOnly: boolean) => void;
}) {
  if (replies.length === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-chat-composer-quick-replies="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <ZapIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="flex-wrap gap-1 py-0.5">
            {replies.map((reply) => (
              <button
                key={reply.id}
                type="button"
                data-chat-composer-quick-reply={reply.id}
                // Taking focus would collapse the composer on mobile and move
                // the caret out of the editor a shift-click is about to fill.
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => onSelect(reply, event.shiftKey)}
                className={cn(
                  "cursor-pointer rounded-full border border-border/60 px-2.5 py-0.5 text-foreground/80 text-xs",
                  "hover:bg-accent/60 hover:text-foreground",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                )}
              >
                {reply.label}
              </button>
            ))}
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
