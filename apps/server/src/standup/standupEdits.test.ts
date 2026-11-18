import { describe, expect, it } from "@effect/vitest";
import type { StandupItem } from "@t3tools/contracts";

import { collectStandupEdits, reconcileInstructedItems } from "./standupEdits.ts";

const item = (overrides: Partial<StandupItem> & { itemId: string; text: string }): StandupItem => ({
  source: "commit",
  excluded: false,
  ...overrides,
});

describe("collectStandupEdits", () => {
  it("reads rewrites, removals, additions and the final order from the stored items", () => {
    const edits = collectStandupEdits([
      item({ itemId: "a", text: "t3code: fixed the panel", generatedText: "Fixed the panel" }),
      item({ itemId: "b", text: "Old work", generatedText: "Old work", excluded: true }),
      item({ itemId: "c", text: "Untouched", generatedText: "Untouched" }),
      item({ itemId: "d", text: "Typed by hand", source: "manual" }),
      item({ itemId: "e", text: "Typed then dropped", source: "manual", excluded: true }),
      item({ itemId: "f", text: "Legacy item without generated text" }),
    ]);

    expect(edits.edited).toEqual([{ before: "Fixed the panel", after: "t3code: fixed the panel" }]);
    expect(edits.removed).toEqual(["Old work"]);
    expect(edits.added).toEqual(["Typed by hand"]);
    expect(edits.finalOrder).toEqual([
      "t3code: fixed the panel",
      "Untouched",
      "Typed by hand",
      "Legacy item without generated text",
    ]);
  });
});

describe("reconcileInstructedItems", () => {
  const previous = [
    item({ itemId: "a", text: "Fixed the panel", generatedText: "Fixed panel" }),
    item({ itemId: "b", text: "Wrote tests", generatedText: "Wrote tests" }),
    item({ itemId: "m", text: "Typed", source: "manual" }),
  ];

  it("keeps the record under a kept id, so a reworded item still shows its generated text", () => {
    const result = reconcileInstructedItems({
      previous,
      instructed: [
        { itemId: "a", text: "Fixed the panel", source: "commit", excluded: false },
        { itemId: "", text: "Wrote tests and typed", source: "commit", excluded: false },
        { itemId: "b", text: "Reworded by the model", source: "commit", excluded: true },
      ],
      newId: (index) => `new-${index}`,
    });

    expect(result).toEqual([
      {
        itemId: "a",
        text: "Fixed the panel",
        source: "commit",
        excluded: false,
        generatedText: "Fixed panel",
      },
      {
        itemId: "new-1",
        text: "Wrote tests and typed",
        source: "commit",
        excluded: false,
        generatedText: "Wrote tests and typed",
      },
      {
        itemId: "b",
        text: "Reworded by the model",
        source: "commit",
        excluded: true,
        generatedText: "Wrote tests",
      },
    ]);
  });

  it("falls back to the thread source for an unknown one and stores no generated text on a manual item", () => {
    const result = reconcileInstructedItems({
      previous,
      instructed: [
        { itemId: "", text: "Mystery", source: "oracle", excluded: false },
        { itemId: "m", text: "Typed", source: "manual", excluded: false },
      ],
      newId: (index) => `new-${index}`,
    });
    expect(result[0]?.source).toBe("thread");
    expect(result[1]).toEqual(previous[2]);
  });
});
