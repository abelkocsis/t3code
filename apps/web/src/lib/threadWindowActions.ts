import type { ScopedThreadRef } from "@t3tools/contracts";

import { flushComposerDraftStorage } from "../composerDraftStore";
import { focusThreadWindow } from "../threadWindows";

/** Opens the thread in its own window. The new window reads saved drafts, so pending ones are saved first. */
export function openThreadInWindow(threadRef: ScopedThreadRef): void {
  flushComposerDraftStorage();
  focusThreadWindow(threadRef);
}
