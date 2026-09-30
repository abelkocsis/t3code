import { describe, expect, it } from "vite-plus/test";

import {
  extractShellCommand,
  isShellFenceLanguage,
  shellCommandPasteData,
} from "./markdown-shell-commands";

describe("isShellFenceLanguage", () => {
  it("accepts the shell fence languages", () => {
    for (const language of ["bash", "sh", "zsh", "shell", "console", "Bash"]) {
      expect(isShellFenceLanguage(language)).toBe(true);
    }
  });

  it("rejects every other language", () => {
    for (const language of ["ts", "python", "json", "text", ""]) {
      expect(isShellFenceLanguage(language)).toBe(false);
    }
  });
});

describe("extractShellCommand", () => {
  it("keeps a script fence unchanged", () => {
    expect(extractShellCommand("kubectl -n attestor port-forward svc/attestor-1 9811:9811")).toBe(
      "kubectl -n attestor port-forward svc/attestor-1 9811:9811",
    );
  });

  it("keeps every line of a multi-line script", () => {
    expect(extractShellCommand("cd /tmp\nls -la\n")).toBe("cd /tmp\nls -la");
  });

  it("drops the prompt and the output of a session transcript", () => {
    const code = ["$ kubectl get pods", "NAME   READY", "attestor-1   1/1", "$ exit"].join("\n");
    expect(extractShellCommand(code)).toBe("kubectl get pods\nexit");
  });

  it("keeps a comment, which the shell accepts", () => {
    expect(extractShellCommand("# port-forward the attestor\nkubectl get pods")).toBe(
      "# port-forward the attestor\nkubectl get pods",
    );
  });

  it("returns null for an empty fence", () => {
    expect(extractShellCommand("   \n\n")).toBeNull();
  });

  it("returns null for a fence the terminal write rejects", () => {
    expect(extractShellCommand("x".repeat(65_001))).toBeNull();
  });
});

describe("shellCommandPasteData", () => {
  it("writes a single command as plain text, so the shell waits for Enter", () => {
    expect(shellCommandPasteData("ls -la")).toBe("ls -la");
  });

  it("wraps a multi-line command in bracketed paste markers", () => {
    expect(shellCommandPasteData("cd /tmp\nls -la")).toBe("\u001b[200~cd /tmp\rls -la\u001b[201~");
  });
});
