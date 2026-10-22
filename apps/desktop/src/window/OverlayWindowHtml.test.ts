import { describe, expect, it } from "vite-plus/test";

import {
  clampOverlayHeight,
  clampOverlayWidth,
  estimateOverlayHeight,
  buildOverlayDataUrl,
  OVERLAY_INITIAL_HEIGHT,
  OVERLAY_WIDTH,
} from "./OverlayWindowHtml.ts";

describe("estimateOverlayHeight", () => {
  it("returns the pill height when there is nothing to list", () => {
    expect(estimateOverlayHeight(0)).toBe(44);
  });

  it("grows with each row", () => {
    expect(estimateOverlayHeight(2)).toBeGreaterThan(estimateOverlayHeight(1));
  });

  it("stops growing past the rows the list can show, so a long list still fits a screen", () => {
    expect(estimateOverlayHeight(20)).toBe(estimateOverlayHeight(5));
  });

  it("leaves room for a whole row, which the earlier constants did not", () => {
    // The bug this replaces: one row was given less height than one row needs,
    // so a single item always drew a scrollbar.
    expect(estimateOverlayHeight(1) - estimateOverlayHeight(0)).toBeGreaterThan(100);
  });

  it("treats a negative count as empty rather than shrinking below the pill", () => {
    expect(estimateOverlayHeight(-1)).toBe(44);
  });
});

describe("clampOverlayHeight", () => {
  it("keeps a sensible measurement unchanged", () => {
    expect(clampOverlayHeight(220)).toBe(220);
  });

  it("rounds a fractional measurement up so content is never cut by a pixel", () => {
    expect(clampOverlayHeight(220.2)).toBe(221);
  });

  it("refuses a zero from a mid-reflow measurement", () => {
    expect(clampOverlayHeight(0)).toBeGreaterThan(0);
  });

  it("falls back to the starting height when the measurement is not a number", () => {
    expect(clampOverlayHeight(Number.NaN)).toBe(OVERLAY_INITIAL_HEIGHT);
  });

  it("caps a runaway measurement so the overlay cannot cover the screen", () => {
    expect(clampOverlayHeight(5_000)).toBeLessThan(1_000);
  });
});

describe("clampOverlayWidth", () => {
  it("keeps the resting card's own width", () => {
    expect(clampOverlayWidth(OVERLAY_WIDTH)).toBe(OVERLAY_WIDTH);
  });

  it("allows the wider step-away layout through, which the old bound cut off", () => {
    // The bug this guards: the clamp capped every report at the card's width,
    // so step away drew 460px of content inside a 340px window and lost the
    // right-hand side to `overflow: hidden`.
    expect(clampOverlayWidth(500)).toBe(500);
  });

  it("still refuses a nonsense measurement", () => {
    expect(clampOverlayWidth(5_000)).toBeLessThan(1_000);
    expect(clampOverlayWidth(Number.NaN)).toBe(OVERLAY_WIDTH);
  });
});

describe("buildOverlayDataUrl", () => {
  // The page ships as a data URL, so the markup is read back out of it.
  const html = decodeURIComponent(buildOverlayDataUrl());

  it("offers step away mode from the menu, the overlay's only way in", () => {
    expect(html).toContain("data-stepaway");
    expect(html).toContain("Step away mode");
  });

  it("offers a way back out, since the mode ignores focus and hides for nothing", () => {
    expect(html).toContain('id="exit"');
  });

  it("keeps its strict policy, which a new script block would break", () => {
    expect(html).toContain("script-src 'unsafe-inline'");
  });
});
