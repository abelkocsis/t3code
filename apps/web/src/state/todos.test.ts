import type { TodoItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { partitionTodos } from "./todos";

function makeItem(overrides: Partial<TodoItem> & { itemId: string }): TodoItem {
  return { text: overrides.itemId, done: false, ...overrides };
}

describe("partitionTodos", () => {
  it("keeps the stored order for the open items", () => {
    const items = [makeItem({ itemId: "a" }), makeItem({ itemId: "b" }), makeItem({ itemId: "c" })];

    expect(partitionTodos(items).open.map((item) => item.itemId)).toEqual(["a", "b", "c"]);
  });

  it("puts the most recently ticked item at the top of the done list", () => {
    const items = [
      makeItem({ itemId: "older", done: true, doneAt: "2026-09-23T10:00:00.000Z" }),
      makeItem({ itemId: "open" }),
      makeItem({ itemId: "newer", done: true, doneAt: "2026-09-24T10:00:00.000Z" }),
    ];

    const { open, done } = partitionTodos(items);

    expect(open.map((item) => item.itemId)).toEqual(["open"]);
    expect(done.map((item) => item.itemId)).toEqual(["newer", "older"]);
  });
});
