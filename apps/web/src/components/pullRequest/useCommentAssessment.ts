import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type {
  PullRequestCommentAssessment,
  ModelSelection,
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

const cache = new Map<string, Promise<PullRequestCommentAssessment>>();
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
const visible = () => document.visibilityState === "visible";

export function useCommentAssessment(input: {
  enabled: boolean;
  includeIssues: boolean;
  reading: boolean;
  detail: PullRequestDetailView | null;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  modelSelection: ModelSelection | null;
}) {
  const isVisible = useSyncExternalStore(subscribeVisibility, visible, () => false);
  const allowed = useAtomValue(
    pullRequestEnvironment.assessComments.permissionAtom(input.environmentId),
  );
  const assess = useAtomCommand(pullRequestEnvironment.assessComments, { reportFailure: false });
  const fingerprint = input.detail
    ? JSON.stringify([
        input.environmentId,
        input.detail.url,
        input.detail.headSha,
        input.detail.title,
        input.detail.body,
        input.includeIssues,
        input.detail.comments,
        input.detail.reviewThreads,
        input.detail.commits,
        input.modelSelection,
      ])
    : "";
  const enabled = input.enabled && isVisible && allowed && input.modelSelection !== null;
  const [state, setState] = useState<{
    key: string;
    result?: PullRequestCommentAssessment;
    error?: string;
  }>({ key: "" });
  const run = useEffectEvent(async () => {
    const result = await assess({
      environmentId: input.environmentId,
      input: {
        ...input.reference,
        modelSelection: input.modelSelection!,
        includeIssues: input.includeIssues,
      },
    });
    if (result._tag === "Failure")
      throw new Error("Could not assess comments. Reopen the PR to retry.");
    return result.value;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- assesses external PR revisions only while this thread's view is visible
  useEffect(() => {
    if (!enabled || input.reading || !fingerprint) return;
    let active = true;
    let pending = cache.get(fingerprint);
    if (!pending) {
      pending = run();
      cache.set(fingerprint, pending);
      if (cache.size > 100) cache.delete(cache.keys().next().value!);
    }
    void pending.then(
      (result) => {
        if (active) setState({ key: fingerprint, result });
      },
      () => {
        cache.delete(fingerprint);
        if (active)
          setState({
            key: fingerprint,
            error: "Comment assessment failed. Reopen the PR to retry.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, input.reading, fingerprint]);
  return {
    result: enabled && state.key === fingerprint ? state.result : undefined,
    error: enabled && state.key === fingerprint ? state.error : undefined,
    stage: !enabled
      ? null
      : input.reading
        ? "Reading comments"
        : state.key !== fingerprint
          ? input.includeIssues
            ? "Assessing resolutions"
            : "Generating summary"
          : null,
  };
}
