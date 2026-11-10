import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useForkThreadStates, useSetThreadFactory, useSetThreadFolder } from "~/state/fork";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { newThreadId } from "~/lib/utils";

export function useCreateFactoryReviewThread(environmentId: EnvironmentId) {
  const states = useForkThreadStates();
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const remove = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setFactory = useSetThreadFactory();
  const setFolder = useSetThreadFolder();
  const { changeLink } = usePullRequestLinking(environmentId);
  return async (source: EnvironmentThreadShell, url: string, title: string) => {
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const created = await create({
      environmentId: source.environmentId,
      input: {
        threadId,
        projectId: source.projectId,
        title,
        modelSelection: source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch: source.branch,
        worktreePath: source.worktreePath,
        createdAt,
      },
    });
    if (created._tag === "Failure") throw new Error("Could not create the factory review thread.");
    const ref = scopeThreadRef(source.environmentId, threadId);
    const sourceState = states.get(
      scopedThreadKey(scopeThreadRef(source.environmentId, source.id)),
    );
    let failure: unknown = null;
    try {
      await changeLink(ref, url, true);
      const folder = await setFolder(source.environmentId, threadId, sourceState?.folderId ?? null);
      if (folder._tag === "Failure") {
        failure = new Error("The new review thread could not join the group.");
      } else {
        const flagged = await setFactory(source.environmentId, threadId, {
          input: { kind: "pull-request", value: url },
          phase: "ready-for-review",
          summary: null,
          startedAt: createdAt,
          updatedAt: createdAt,
          ...(sourceState?.factory?.folderId ? { folderId: sourceState.factory.folderId } : {}),
        });
        if (flagged._tag === "Failure")
          failure = new Error("The review thread could not join the factory.");
      }
    } catch (error) {
      failure = error ?? new Error("Could not set up the review thread.");
    }
    if (failure !== null) {
      const removed = await remove({ environmentId: source.environmentId, input: { threadId } });
      if (removed._tag === "Failure")
        throw new Error(
          "Factory setup failed. The incomplete review thread remains in the sidebar.",
          { cause: failure },
        );
      throw failure;
    }
  };
}
