import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OverlayItem } from "@t3tools/client-runtime/state/overlay-visibility";
import {
  isThreadAttentionUnseen,
  resolveThreadAttention,
  shortAttentionLabel,
} from "@t3tools/client-runtime/state/thread-attention";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";

export interface AttentionThreads {
  /** Threads whose current phase the user has not looked at, newest first. */
  readonly unseen: readonly OverlayItem[];
  /** Threads with an agent still running or starting. */
  readonly workingCount: number;
}

/**
 * The single definition of "needs the user" for every away-from-the-app
 * surface.
 *
 * The dock badge and the overlay window must never disagree about what is
 * waiting, so both read this rather than walking the shells themselves.
 */
export function useAttentionThreads(): AttentionThreads {
  const threads = useThreadShells();
  const projects = useProjects();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  return useMemo(() => {
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const unseen: OverlayItem[] = [];
    let workingCount = 0;

    for (const thread of threads) {
      const phase = resolveThreadAwarenessPhase(thread);
      if (phase === "running" || phase === "starting") {
        workingCount += 1;
        continue;
      }
      const attention = resolveThreadAttention(thread);
      if (attention === null) continue;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (!isThreadAttentionUnseen({ attention, lastVisitedAt: threadLastVisitedAtById[key] })) {
        continue;
      }
      unseen.push({
        environmentId: thread.environmentId,
        threadId: thread.id,
        threadTitle: thread.title,
        projectTitle: projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
        phase: attention.phase,
      });
    }

    return { unseen, workingCount };
  }, [projects, threadLastVisitedAtById, threads]);
}

/** Overlay row text. Kept here so the label never drifts from the phase. */
export function attentionItemLabel(item: OverlayItem): string {
  return shortAttentionLabel(item.phase);
}
