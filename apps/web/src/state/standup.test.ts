import type { StandupItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatStandupHtml, formatStandupText } from "./standup";

function makeItem(overrides: Partial<StandupItem> & { itemId: string }): StandupItem {
  return { text: overrides.itemId, source: "thread", excluded: false, ...overrides };
}

describe("formatStandupHtml", () => {
  it("renders only the kept items as one list", () => {
    const items = [
      makeItem({ itemId: "a", text: "Merged PR #66" }),
      makeItem({ itemId: "b", text: "Dropped", excluded: true }),
      makeItem({ itemId: "c", text: "Opened PR #16" }),
    ];

    expect(formatStandupHtml(items)).toBe("<ul><li>Merged PR #66</li><li>Opened PR #16</li></ul>");
    expect(formatStandupText(items)).toBe("• Merged PR #66\n• Opened PR #16");
  });

  it("escapes markup inside a bullet", () => {
    const items = [makeItem({ itemId: "a", text: 'Fixed <Button> & "quotes"' })];

    expect(formatStandupHtml(items)).toBe(
      "<ul><li>Fixed &lt;Button&gt; &amp; &quot;quotes&quot;</li></ul>",
    );
  });
});
