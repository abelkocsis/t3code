import { cva } from "class-variance-authority";
import {
  type AttentionPhase,
  type AttentionThreadInput,
  isThreadAttentionUnseen,
  resolveThreadAttention,
} from "@t3tools/client-runtime/state/thread-attention";
import type { SidebarThreadStatus } from "../Sidebar.logic";

// Lives apart from the row so an upstream rewrite of the row markup cannot drop it.
// An unseen row carries a bar, a wash, and a ring in the colour of what it wants.
export const sidebarUnseenRowVariants = cva(
  "before:absolute before:inset-y-0 before:left-0 before:w-[4px] before:content-[''] ring-1 ring-inset",
  {
    variants: {
      phase: {
        waiting_for_approval: "before:bg-warning bg-warning/15 ring-warning/35",
        waiting_for_input: "before:bg-info bg-info/15 ring-info/35",
        failed: "before:bg-error bg-error/15 ring-error/35",
        completed: "before:bg-success bg-success/15 ring-success/35",
      } satisfies Record<AttentionPhase, string>,
    },
  },
);

export const sidebarUnseenTitleClassName = "font-semibold";

export function resolveSidebarUnseenPhase(input: {
  readonly thread: Omit<AttentionThreadInput, "status"> & { readonly status: SidebarThreadStatus };
  readonly lastVisitedAt: string | null | undefined;
}): AttentionPhase | null {
  const status = input.thread.status;
  const attention = resolveThreadAttention({
    ...input.thread,
    status: status === "request" ? "input" : status === "preparing" ? "working" : status,
  });
  if (attention === null) return null;
  return isThreadAttentionUnseen({ attention, lastVisitedAt: input.lastVisitedAt })
    ? attention.phase
    : null;
}
