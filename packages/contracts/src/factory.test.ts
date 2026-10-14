import { describe, expect, it } from "vite-plus/test";

import {
  classifyFactoryInput,
  factoryInputRepository,
  parseFactoryPhaseMarker,
  renderFactoryPrompt,
} from "./factory.ts";

describe("parseFactoryPhaseMarker", () => {
  it("reads the phase word and the sentence", () => {
    expect(parseFactoryPhaseMarker("FACTORY PHASE: review Three reviewers read the diff.")).toEqual(
      { phase: "review", summary: "Three reviewers read the diff." },
    );
  });

  it("returns null summary when only the word is given", () => {
    expect(parseFactoryPhaseMarker("FACTORY PHASE: done")).toEqual({
      phase: "done",
      summary: null,
    });
  });

  it("takes the last marker in a multi-line message", () => {
    const text = [
      "Some prose first.",
      "FACTORY PHASE: implementation Writing the code.",
      "More prose.",
      "**FACTORY PHASE: review** Reviewers start now.",
    ].join("\n");
    expect(parseFactoryPhaseMarker(text)).toEqual({
      phase: "review",
      summary: "Reviewers start now.",
    });
  });

  it("ignores lines with unknown phase words", () => {
    expect(parseFactoryPhaseMarker("FACTORY PHASE: shipping it")).toBeNull();
    expect(parseFactoryPhaseMarker("no marker here")).toBeNull();
  });

  it("ignores case on the prefix and the word", () => {
    expect(parseFactoryPhaseMarker("factory phase: Human-Gate Need a decision.")).toEqual({
      phase: "human-gate",
      summary: "Need a decision.",
    });
  });
});

describe("classifyFactoryInput", () => {
  it("recognises a GitHub issue URL", () => {
    const input = classifyFactoryInput(" https://github.com/DLC-link/omnibus/issues/54 ");
    expect(input).toEqual({
      kind: "github-issue",
      value: "https://github.com/DLC-link/omnibus/issues/54",
    });
    expect(factoryInputRepository(input!)).toBe("dlc-link/omnibus");
  });

  it("recognises a Notion page URL", () => {
    expect(classifyFactoryInput("https://www.notion.so/bitsafe/Some-page-abc123")?.kind).toBe(
      "notion-page",
    );
  });

  it("treats a pull request URL as a pull request and plain text as free text", () => {
    expect(classifyFactoryInput("https://github.com/DLC-link/omnibus/pull/65")?.kind).toBe(
      "pull-request",
    );
    expect(
      factoryInputRepository({
        kind: "pull-request",
        value: "https://github.com/DLC-link/omnibus/pull/65",
      }),
    ).toBe("dlc-link/omnibus");
    expect(classifyFactoryInput("Add a range cap to the holders route")).toEqual({
      kind: "free-text",
      value: "Add a range cap to the holders route",
    });
    expect(factoryInputRepository({ kind: "free-text", value: "x" })).toBeNull();
    expect(
      factoryInputRepository({
        kind: "free-text",
        value: "https://github.com/abelkocsis/code-factory-mock/blob/main/tasks/01-add-file-a.md",
      }),
    ).toBe("abelkocsis/code-factory-mock");
  });

  it("rejects empty text", () => {
    expect(classifyFactoryInput("   ")).toBeNull();
  });
});

describe("renderFactoryPrompt", () => {
  it("fills every input placeholder", () => {
    expect(
      renderFactoryPrompt("Task: {{input}} again {{ input }}", { kind: "free-text", value: "X" }),
    ).toBe("Task: X again X");
  });
});
