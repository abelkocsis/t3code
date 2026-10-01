/**
 * Sidebar folders: the list itself and the writes that change it.
 *
 * A folder is a record in each server's settings, so it outlives its threads
 * and survives a restart. Threads reference it by id, which keeps a rename to
 * one write. Every connected server that stores folders gets the same list,
 * so a thread on one machine can join a folder made on another.
 */
import { ThreadFolderId, type EnvironmentId, type SidebarFolder } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { randomUUID } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

interface FolderTarget {
  readonly environmentId: EnvironmentId;
  readonly folders: readonly SidebarFolder[];
}

export interface ThreadFoldersApi {
  /** Every folder the connected servers know, in the order they were made. */
  readonly folders: readonly SidebarFolder[];
  /** False when no connected server can store a folder. */
  readonly supported: boolean;
  readonly createFolder: (name: string) => Promise<ThreadFolderId | null>;
  readonly renameFolder: (id: ThreadFolderId, name: string) => Promise<void>;
  /** Puts `id` at `index` in the sidebar's folder order. */
  readonly moveFolder: (id: ThreadFolderId, index: number) => Promise<void>;
  readonly deleteFolder: (id: ThreadFolderId) => Promise<void>;
}

export function useThreadFolders(): ThreadFoldersApi {
  const { environments } = useEnvironments();
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "sidebar folders update",
  );

  const targets = useMemo(
    (): readonly FolderTarget[] =>
      environments.flatMap((environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.threadFolders === true
          ? [
              {
                environmentId: environment.environmentId,
                folders: environment.serverConfig.settings.sidebarFolders ?? [],
              },
            ]
          : [],
      ),
    [environments],
  );

  // The first server wins a contested name, which only happens when a write
  // reached one machine and not another.
  const folders = useMemo(() => {
    const merged = new Map<ThreadFolderId, SidebarFolder>();
    for (const target of targets) {
      for (const folder of target.folders) {
        if (!merged.has(folder.id)) merged.set(folder.id, folder);
      }
    }
    return [...merged.values()];
  }, [targets]);

  const writeFolders = useCallback(
    async (next: (current: readonly SidebarFolder[]) => readonly SidebarFolder[]) => {
      await Promise.all(
        targets.map((target) =>
          persistServerSettings({
            environmentId: target.environmentId,
            input: { patch: { sidebarFolders: next(target.folders) } },
          }),
        ),
      );
    },
    [persistServerSettings, targets],
  );

  const createFolder = useCallback(
    async (name: string) => {
      if (targets.length === 0) return null;
      const folder: SidebarFolder = { id: ThreadFolderId.make(`folder_${randomUUID()}`), name };
      await writeFolders((current) => [...current, folder]);
      return folder.id;
    },
    [targets.length, writeFolders],
  );

  const renameFolder = useCallback(
    async (id: ThreadFolderId, name: string) => {
      await writeFolders((current) =>
        current.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      );
    },
    [writeFolders],
  );

  const moveFolder = useCallback(
    async (id: ThreadFolderId, index: number) => {
      await writeFolders((current) => {
        const from = current.findIndex((folder) => folder.id === id);
        if (from < 0) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) return current;
        next.splice(Math.max(0, Math.min(index, next.length)), 0, moved);
        return next;
      });
    },
    [writeFolders],
  );

  const deleteFolder = useCallback(
    async (id: ThreadFolderId) => {
      await writeFolders((current) => current.filter((folder) => folder.id !== id));
    },
    [writeFolders],
  );

  return useMemo(
    () => ({
      folders,
      supported: targets.length > 0,
      createFolder,
      renameFolder,
      moveFolder,
      deleteFolder,
    }),
    [createFolder, deleteFolder, folders, moveFolder, renameFolder, targets.length],
  );
}
