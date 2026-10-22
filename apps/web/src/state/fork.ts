import type { EnvironmentId, ForkThreadState, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createForkEnvironmentAtoms } from "@t3tools/client-runtime/state/fork";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironmentIds } from "./environments";
import { useAtomCommand } from "./use-atom-command";

export const forkEnvironment = createForkEnvironmentAtoms(connectionAtomRuntime);

const forkThreadStatesAtom = environmentAtomList("web-fork-thread-states", (environmentId) =>
  forkEnvironment.threadStates({ environmentId, input: {} }),
);

const EMPTY: ReadonlyMap<string, ForkThreadState> = new Map();

/**
 * The fork's row for every thread on every connected environment, keyed by
 * the scoped thread key so a sidebar row can look its own up directly.
 * Environments that have not answered yet contribute nothing.
 */
export function useForkThreadStates(): ReadonlyMap<string, ForkThreadState> {
  const environmentIds = useEnvironmentIds();
  const results = useAtomValue(forkThreadStatesAtom(environmentIdsKey(environmentIds)));
  let merged: Map<string, ForkThreadState> | null = null;
  results.forEach((result, index) => {
    if (result._tag !== "Success") return;
    const environmentId = environmentIds[index]!;
    result.value.forEach((state, threadId) => {
      merged ??= new Map();
      merged.set(scopedThreadKey(scopeThreadRef(environmentId, threadId)), state);
    });
  });
  return merged ?? EMPTY;
}

export function useSetThreadFolder() {
  const setThreadFolder = useAtomCommand(forkEnvironment.setThreadFolder);
  return (environmentId: EnvironmentId, threadId: ThreadId, folderId: ThreadFolderId | null) =>
    setThreadFolder({ environmentId, input: { threadId, folderId } });
}
