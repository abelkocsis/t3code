import { describe, expect, it } from "vite-plus/test";

import {
  clampOverlayHeight,
  estimateOverlayHeight,
  OVERLAY_INITIAL_HEIGHT,
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
