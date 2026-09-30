import type { ScopedThreadRef } from "@t3tools/contracts";

// Tiny event bus letting a rendered code block reach the terminal the chat view
// owns, without threading a callback through every markdown renderer.
const TERMINAL_PASTE_EVENT = "t3code:paste-into-terminal";

export interface TerminalPasteDetail {
  readonly threadRef: ScopedThreadRef;
  /** Bytes written to the terminal verbatim. */
  readonly data: string;
  readonly target: "active" | "new";
}

export function pasteIntoThreadTerminal(detail: TerminalPasteDetail): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_PASTE_EVENT, { detail }));
}

export function onPasteIntoThreadTerminal(
  listener: (detail: TerminalPasteDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<TerminalPasteDetail>).detail);
  };
  window.addEventListener(TERMINAL_PASTE_EVENT, handler);
  return () => window.removeEventListener(TERMINAL_PASTE_EVENT, handler);
}
