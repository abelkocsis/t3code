import { Atom } from "effect/reactivity";
import { forkEnvironment } from "../../state/fork";
import { useWindowFocused } from "../../hooks/useWindowFocused";
import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@t3tools/contracts";

import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const idleTracker = Atom.make(undefined);

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: Atom.family((ref: ScopedThreadRef) =>
    Atom.make((get) => {
      const shell = get(environmentThreadShells.threadShellAtom(ref));
      if (shell === null) return null;
      const result = get(
        forkEnvironment.threadStates({ environmentId: ref.environmentId, input: {} }),
      );
      const updatedAt =
        result._tag === "Success" ? result.value.get(ref.threadId)?.factory?.updatedAt : null;
      return updatedAt && Date.parse(updatedAt) > Date.parse(shell.updatedAt)
        ? { ...shell, updatedAt }
        : shell;
    }),
  ),
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  const focused = useWindowFocused();
  useAtomMount(focused ? threadVisitTracker(props.threadRef) : idleTracker);
  return null;
}
