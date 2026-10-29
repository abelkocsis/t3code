import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  FACTORY_IGNORE_CI_RULE,
  renderFactoryPrompt,
  type FactoryInput,
  type ModelSelection,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { RegistryContext } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { newMessageId, newThreadId } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { useSetThreadFactory } from "../../state/fork";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";

export type StartFactoryTaskResult = { ok: true } | { ok: false; title: string; detail?: string };

const BRANCH_READ_TIMEOUT_MS = 20_000;

/**
 * Starts one factory task: a thread in its own worktree off the project's current branch,
 * the first message from the prompt template, and the factory flag so the page lists it.
 */
export function useStartFactoryTask(): (
  input: FactoryInput,
  project: EnvironmentProject,
  options?: {
    readonly title?: string;
    /** The model and effort picked for this task; absent uses the project default. */
    readonly modelSelection?: ModelSelection | null;
  },
) => Promise<StartFactoryTaskResult> {
  const configs = useServerConfigs();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const setFactory = useSetThreadFactory();
  const registry = useContext(RegistryContext);

  return async (input, project, options) => {
    const settings = resolveProjectSettings(
      configs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
    ).settings;
    const modelSelection =
      options?.modelSelection ?? settings.defaultModelSelection ?? project.defaultModelSelection;
    if (!modelSelection) {
      return { ok: false, title: "Pick a default model for the project first" };
    }
    // The live git status stream never settles, so this takes its first reading.
    const statusAtom = vcsEnvironment.status({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    });
    const statusReady = await waitForAtomValue({
      registry,
      atom: statusAtom,
      predicate: (result) => AsyncResult.isSuccess(result) && result.value !== null,
      timeoutMs: BRANCH_READ_TIMEOUT_MS,
    });
    const baseBranch = statusReady
      ? (Option.getOrNull(AsyncResult.value(registry.get(statusAtom)))?.refName ?? null)
      : null;
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
          text: [
            renderFactoryPrompt(settings.factoryPromptTemplate, input),
            ...(settings.factoryIgnoreCiEnabled && settings.factoryIgnoreCi
              ? [FACTORY_IGNORE_CI_RULE]
              : []),
          ].join("\n\n"),
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
            ...(settings.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        },
      },
    });
    const flag = (summary: string | null) =>
      setFactory(project.environmentId, threadId, {
        input,
        phase: "requirements",
        summary,
        startedAt: createdAt,
        updatedAt: createdAt,
      });
    if (result._tag === "Failure") {
      const detail = readableFailure(
        squashAtomCommandFailure(result),
        "Check the project branch and the default model.",
      );
      // A failed worktree leaves the thread in place with a failed run. Flag it anyway, so it
      // shows on the page with its error instead of surfacing as a stray sidebar thread.
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
  };
}
