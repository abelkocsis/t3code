import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

/**
 * Which sidebar folders are closed. Membership lives on the server, but how
 * much of it a screen shows is a per-device choice: a phone and a wide
 * desktop want different amounts open.
 */
const STORAGE_KEY = "t3code:sidebar-collapsed-folders:v1";
const CollapsedFoldersSchema = Schema.Array(Schema.String);

export function readCollapsedFolders(): ReadonlySet<string> {
  try {
    return new Set(getLocalStorageItem(STORAGE_KEY, CollapsedFoldersSchema) ?? []);
  } catch (error) {
    console.error("Could not read closed sidebar folders.", error);
    return new Set();
  }
}

export function saveCollapsedFolders(folders: ReadonlySet<string>): void {
  try {
    setLocalStorageItem(STORAGE_KEY, [...folders], CollapsedFoldersSchema);
  } catch (error) {
    console.error("Could not save closed sidebar folders.", error);
  }
}
