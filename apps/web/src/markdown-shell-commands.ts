const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * Encodes a chat code block for `terminal.write` so it waits at the prompt
 * instead of running. A single line goes as plain text. The shell would run
 * every line but the last one of a bare multi-line write, so a multi-line
 * command travels as a bracketed paste and stays in the edit buffer.
 */
export function shellCommandPasteData(command: string): string {
  if (!command.includes("\n")) {
    return command;
  }
  return `${BRACKETED_PASTE_START}${command.replace(/\n/g, "\r")}${BRACKETED_PASTE_END}`;
}
