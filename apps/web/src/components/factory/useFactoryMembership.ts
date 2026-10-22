import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_FACTORY_PROMPT_TEMPLATE,
  FACTORY_JOIN_TASK,
  FACTORY_PHASE_LABELS,
  renderFactoryPrompt,
  type ThreadFactory,
} from "@t3tools/contracts";

import { useThreadActions } from "../../hooks/useThreadActions";
import { newMessageId } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { useSetThreadFactory } from "../../state/fork";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { toastManager } from "../ui/toast";
import { factoryJoinState } from "./factory.logic";

/**
 * Adds an existing thread to the Factory page, or takes a task off it. Taking a task off keeps
 * the thread and its conversation.
 */
export function useFactoryMembership(): {
  readonly addToFactory: (thread: EnvironmentThreadShell) => Promise<void>;
  readonly removeFromFactory: (
    thread: EnvironmentThreadShell,
    factory: ThreadFactory,
  ) => Promise<void>;
} {
  const configs = useServerConfigs();
  const setFactory = useSetThreadFactory();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const { unsnoozeThread } = useThreadActions();

  const addToFactory = async (thread: EnvironmentThreadShell) => {
    const { factory, askAgent } = factoryJoinState(thread, new Date().toISOString());
    const flagged = await setFactory(thread.environmentId, thread.id, factory);
    if (flagged._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not add the thread to the Factory",
        description: readableFailure(squashAtomCommandFailure(flagged), "Try again."),
      });
      return;
    }
    if (!askAgent) {
      toastManager.add({
        type: "success",
        title: "Added to the Factory",
        description: FACTORY_PHASE_LABELS[factory.phase],
      });
      return;
    }
    const template =
      configs.get(thread.environmentId)?.settings.factoryPromptTemplate ??
      DEFAULT_FACTORY_PROMPT_TEMPLATE;
    const sent = await startTurn({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: renderFactoryPrompt(template, { kind: "free-text", value: FACTORY_JOIN_TASK }),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
    });
    if (sent._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Added to the Factory, but the agent did not get the message",
        description: readableFailure(
          squashAtomCommandFailure(sent),
          "Ask the agent for its phase from the Factory page.",
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Added to the Factory",
      description: "The agent works out which phase the task is in.",
    });
  };

  const removeFromFactory = async (thread: EnvironmentThreadShell, factory: ThreadFactory) => {
    const cleared = await setFactory(thread.environmentId, thread.id, null);
    if (cleared._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not remove the task from the Factory",
        description: readableFailure(squashAtomCommandFailure(cleared), "Try again."),
      });
      return;
    }
    // Only the factory wakes a task that sleeps behind a pull request, so wake it here.
    if (factory.blockedBy) {
      await unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
    }
    toastManager.add({
      type: "success",
      title: "Removed from the Factory",
      description: "The thread stays in the sidebar.",
    });
  };

  return { addToFactory, removeFromFactory };
}
