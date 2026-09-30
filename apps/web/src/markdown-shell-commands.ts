/**
 * Decides which markdown code fences can be sent to a thread terminal, and
 * turns a fence body into the bytes the terminal receives.
 */

const SHELL_FENCE_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console"]);

/** A session transcript marks its commands with a `$ ` prompt; the other lines are output. */
const PROMPT_PREFIX_REGEX = /^[ \t]*\$[ \t]+/;

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/** `TerminalWriteInput` rejects longer data, and the markers add to the payload. */
const MAX_SHELL_COMMAND_LENGTH = 65_000;

export function isShellFenceLanguage(language: string): boolean {
  return SHELL_FENCE_LANGUAGES.has(language.toLowerCase());
}

/**
 * Returns the commands a shell fence holds, or null when it holds none. A fence
 * that prompts any line is a session transcript, so its unprompted lines are
 * output and drop out. A fence that prompts no line is a script, so every line
 * stays.
 */
export function extractShellCommand(code: string): string | null {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const isTranscript = lines.some((line) => PROMPT_PREFIX_REGEX.test(line));
  const commandLines = isTranscript
    ? lines
        .filter((line) => PROMPT_PREFIX_REGEX.test(line))
        .map((line) => line.replace(PROMPT_PREFIX_REGEX, ""))
    : lines;
  const command = commandLines.join("\n").trim();
  if (command.length === 0 || command.length > MAX_SHELL_COMMAND_LENGTH) {
    return null;
  }
  return command;
}

/**
 * Encodes a command for `terminal.write`. The shell runs every line but the
 * last one when it reads a bare multi-line write, so a multi-line command
 * travels as a bracketed paste and waits in the edit buffer instead.
 */
export function shellCommandPasteData(command: string): string {
  if (!command.includes("\n")) {
    return command;
  }
  return `${BRACKETED_PASTE_START}${command.replace(/\n/g, "\r")}${BRACKETED_PASTE_END}`;
}
