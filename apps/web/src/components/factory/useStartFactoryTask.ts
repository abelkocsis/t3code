import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  renderFactoryPrompt,
  type FactoryInput,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { RegistryContext } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";

import { newMessageId, newThreadId, randomHex } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";

export type StartFactoryTaskResult = { ok: true } | { ok: false; title: string; detail?: string };

const BRANCH_READ_TIMEOUT_MS = 20_000;

/**
 * The project's current branch, from the live git status stream. The stream never settles,
 * so this takes its first value instead of waiting for a final one.
 */
function readCurrentBranch(
  registry: AtomRegistry.AtomRegistry,
  project: EnvironmentProject,
): Promise<string | null> {
  return new Promise((resolve) => {
    const atom = vcsEnvironment.status({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    });
    let done = false;
    let unsubscribe = () => {};
    const finish = (branch: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(branch);
    };
    const timer = setTimeout(() => finish(null), BRANCH_READ_TIMEOUT_MS);
    unsubscribe = registry.subscribe(
      atom,
      (result) => {
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value) finish(value.refName ?? null);
        else if (result._tag === "Failure") finish(null);
      },
      { immediate: true },
    );
  });
}

/**
 * Starts one factory task: a thread in its own worktree off the project's current branch,
 * the first message from the prompt template, and the factory flag so the page lists it.
 */
export function useStartFactoryTask(): (
  input: FactoryInput,
  project: EnvironmentProject,
  options?: { readonly title?: string },
) => Promise<StartFactoryTaskResult> {
  const configs = useServerConfigs();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const setFactory = useAtomCommand(threadEnvironment.setFactory, { reportFailure: false });
  const registry = useContext(RegistryContext);

  return useCallback(
    async (input, project, options) => {
      const settings = resolveProjectSettings(
        configs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
        project.id,
        project,
      ).settings;
      const modelSelection = settings.defaultModelSelection ?? project.defaultModelSelection;
      if (!modelSelection) {
        return { ok: false, title: "Pick a default model for the project first" };
      }
      const baseBranch = await readCurrentBranch(registry, project);
      if (!baseBranch) {
        return { ok: false, title: "The project is not on a git branch" };
      }
      const createdAt = new Date().toISOString();
      const threadId = newThreadId();
      const title =
        options?.title ?? (input.kind === "free-text" ? input.value.slice(0, 80) : input.value);
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: renderFactoryPrompt(settings.factoryPromptTemplate, input),
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode: settings.defaultRuntimeMode,
              interactionMode: "default",
              branch: baseBranch,
              worktreePath: null,
              createdAt,
            },
            prepareWorktree: {
              projectCwd: project.workspaceRoot,
              baseBranch,
              requireWorktree: true,
              branch: buildTemporaryWorktreeBranchName(randomHex),
              ...(settings.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          },
          createdAt,
        },
      });
      const flag = (summary: string | null) =>
        setFactory({
          environmentId: project.environmentId,
          input: {
            threadId,
            factory: {
              input,
              phase: "requirements",
              summary,
              startedAt: createdAt,
              updatedAt: createdAt,
            },
          },
        });
      if (result._tag === "Failure") {
        const detail = readableFailure(
          squashAtomCommandFailure(result),
          "Check the project branch and the default model.",
        );
        // A failed worktree leaves the thread in place with a failed session. Flag it anyway,
        // so it shows on the page with its error instead of surfacing as a stray sidebar thread.
        await flag(detail);
        return { ok: false, title: "Could not start the task", detail };
      }
      const flagged = await flag(null);
      if (flagged._tag === "Failure") {
        return {
          ok: false,
          title: "The task started but is not listed here",
          detail: "Find it in the sidebar.",
        };
      }
      return { ok: true };
    },
    [configs, registry, setFactory, startTurn],
  );
}
