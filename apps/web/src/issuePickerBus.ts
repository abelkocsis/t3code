const ISSUE_PICKER_OPEN_EVENT = "t3code:open-issue-picker";

/**
 * Opens the issue picker from anywhere: the sidebar, the command palette, or a
 * keybinding. The dialog is mounted once at the root, so the places that open
 * it share one event rather than each owning a copy of its state.
 */
export function openIssuePicker(): void {
  window.dispatchEvent(new Event(ISSUE_PICKER_OPEN_EVENT));
}

export function onOpenIssuePicker(listener: () => void): () => void {
  window.addEventListener(ISSUE_PICKER_OPEN_EVENT, listener);
  return () => window.removeEventListener(ISSUE_PICKER_OPEN_EVENT, listener);
}
