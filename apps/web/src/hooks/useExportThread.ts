import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  buildAgentThreadExport,
  buildHumanThreadExport,
  threadExportFilename,
  type ThreadExportKind,
} from "../lib/threadExport";
import { downloadPlanAsTextFile } from "../proposedPlan";
import { useProjects } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";

/** Reads the whole stored history from the server, because the client holds only loaded pages. */
export function useExportThread() {
  const projects = useProjects();
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });

  return async (thread: EnvironmentThreadShell, kind: ThreadExportKind) => {
    const result = await loadThreadTranscript({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to export thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    const transcript = result.value;
    const exportedAt = new Date().toISOString();
    const contents =
      kind === "human"
        ? buildHumanThreadExport({ transcript, exportedAt })
        : buildAgentThreadExport({
            thread,
            project:
              projects.find(
                (project) =>
                  project.environmentId === thread.environmentId && project.id === thread.projectId,
              ) ?? null,
            transcript,
            exportedAt,
          });
    downloadPlanAsTextFile(threadExportFilename(transcript.title, kind), contents);
  };
}
