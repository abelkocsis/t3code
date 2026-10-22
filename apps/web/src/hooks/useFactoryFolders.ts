/**
 * Factory page folders: the list itself and the writes that change it.
 *
 * A folder is a record in each server's settings, apart from the sidebar folders, so
 * filing a task on the Factory page never moves its thread in the sidebar.
 */
import type { EnvironmentId, FactoryFolder } from "@t3tools/contracts";

import { randomUUID } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

interface FolderTarget {
  readonly environmentId: EnvironmentId;
  readonly folders: readonly FactoryFolder[];
}

export interface FactoryFoldersApi {
  readonly folders: readonly FactoryFolder[];
  readonly supported: boolean;
  readonly createFolder: (name: string) => Promise<string | null>;
  readonly renameFolder: (id: string, name: string) => Promise<void>;
  /** Puts `id` at `index` in the folder order. */
  readonly moveFolder: (id: string, index: number) => Promise<void>;
  readonly deleteFolder: (id: string) => Promise<void>;
}

export function useFactoryFolders(): FactoryFoldersApi {
  const { environments } = useEnvironments();
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "factory folders update",
  );

  const targets: readonly FolderTarget[] = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            folders: environment.serverConfig.settings.factoryFolders ?? [],
          },
        ]
      : [],
  );

  // Every connected server holds the same list after a write; the first copy of an id wins.
  const merged = new Map<string, FactoryFolder>();
  for (const target of targets) {
    for (const folder of target.folders) {
      if (!merged.has(folder.id)) merged.set(folder.id, folder);
    }
  }
  const folders = [...merged.values()];

  const writeFolders = async (
    next: (current: readonly FactoryFolder[]) => readonly FactoryFolder[],
  ) => {
    await Promise.all(
      targets.map((target) =>
        persistServerSettings({
          environmentId: target.environmentId,
          input: { patch: { factoryFolders: next(target.folders) } },
        }),
      ),
    );
  };

  return {
    folders,
    supported: targets.length > 0,
    createFolder: async (name) => {
      if (targets.length === 0) return null;
      const folder: FactoryFolder = { id: `factory-folder_${randomUUID()}`, name };
      await writeFolders((current) => [...current, folder]);
      return folder.id;
    },
    renameFolder: async (id, name) => {
      await writeFolders((current) =>
        current.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      );
    },
    moveFolder: async (id, index) => {
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
    deleteFolder: async (id) => {
      await writeFolders((current) => current.filter((folder) => folder.id !== id));
    },
  };
}
