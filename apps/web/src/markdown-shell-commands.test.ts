import { describe, expect, it } from "vite-plus/test";

import { shellCommandPasteData } from "./markdown-shell-commands";

describe("shellCommandPasteData", () => {
  it("writes a single command as plain text, so the shell waits for Enter", () => {
    expect(shellCommandPasteData("ls -la")).toBe("ls -la");
  });

  it("wraps a multi-line command in bracketed paste markers", () => {
    expect(shellCommandPasteData("cd /tmp\nls -la")).toBe("\u001b[200~cd /tmp\rls -la\u001b[201~");
  });
});
