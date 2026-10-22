import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OverlayItem } from "@t3tools/client-runtime/state/overlay-visibility";
import {
  isThreadAttentionDismissed,
  isThreadAttentionUnseen,
  resolveThreadAttention,
  type ThreadAttention,
} from "@t3tools/client-runtime/state/thread-attention";

import {
  factoryAttention,
  factoryAttentionLabel,
  factoryOf,
  isFactoryGateUnseen,
} from "../components/factory/factory.logic";
import {
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../components/Sidebar.logic";
import { useProjects, useThreadShells } from "../state/entities";
import { useForkThreadStates } from "../state/fork";
import { useUiStateStore } from "../uiStateStore";

export interface AttentionThreads {
  /** Threads whose current phase the user has not looked at, in shell order. */
  readonly unseen: readonly OverlayItem[];
  /** Threads with an agent still running or waiting on other work. */
  readonly workingCount: number;
  /** Threads the user hid from the overlay but has still not read. */
  readonly dismissedCount: number;
}

/**
 * What the overlay lists: the sidebar's own reading of each thread, filtered
 * to what the user has not seen.
 *
 * Reads `resolveSidebarThreadStatus` rather than walking the shells itself, so
 * the overlay and the sidebar can never disagree about what is waiting. It
 * also drops a thread the user dismissed from the overlay; the sidebar reads
 * visits only, so it keeps showing that thread as unread.
 */
export function useAttentionThreads(): AttentionThreads {
  const threads = useThreadShells();
  const projects = useProjects();
  const forkThreadStates = useForkThreadStates();
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const overlayDismissedAtById = useUiStateStore((state) => state.overlayDismissedAtById);

  const projectTitleByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const unseen: OverlayItem[] = [];
  let workingCount = 0;
  let dismissedCount = 0;

  for (const thread of threads) {
    if (thread.lineage.relationshipToParent === "subagent") continue;
    // A factory task is read by its own state: its agent finishes turns all the time, so it
    // asks for attention only at a gate, on a question, or on a failure.
    const factory = factoryOf(thread, forkThreadStates);
    const fromFactory = factory ? factoryAttention(thread, factory) : null;
    let status = fromFactory?.status ?? resolveSidebarThreadStatus(thread);
    if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
    if (status === "working" || status === "waiting") {
      if (thread.archivedAt === null) workingCount += 1;
      continue;
    }
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      threadLastVisitedAtById[key],
    );
    let attention: ThreadAttention;
    if (fromFactory?.status === "ready") {
      // The gate stamps the row, not the last turn, and a task nobody opened yet still counts.
      if (fromFactory.gateAt === null) continue;
      if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
      if (!isFactoryGateUnseen(fromFactory.gateAt, lastVisitedAt)) continue;
      attention = { phase: "completed", at: fromFactory.gateAt };
    } else {
      const resolved = resolveThreadAttention({ ...thread, status });
      if (resolved === null) continue;
      if (!isThreadAttentionUnseen({ attention: resolved, lastVisitedAt })) continue;
      attention = resolved;
    }
    if (isThreadAttentionDismissed({ attention, dismissedAt: overlayDismissedAtById[key] })) {
      dismissedCount += 1;
      continue;
    }
    unseen.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      threadTitle: thread.title,
      projectTitle: projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      phase: attention.phase,
      at: attention.at,
      factory: factory ? factoryAttentionLabel(thread, factory) : null,
    });
  }

  return { unseen, workingCount, dismissedCount };
}
