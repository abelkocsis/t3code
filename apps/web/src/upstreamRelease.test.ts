import { describe, expect, it } from "vite-plus/test";

import { resolveUpstreamReleaseStatus, selectLatestStableRelease } from "./upstreamRelease";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/pingdotgg/t3code/releases/tag/${tag}`,
  published_at: "2026-09-17T08:00:00Z",
  ...extra,
});

describe("selectLatestStableRelease", () => {
  it("takes the highest stable version, not the first entry", () => {
    const latest = selectLatestStableRelease([
      release("v0.0.43"),
      release("v0.1.0"),
      release("v0.0.44"),
    ]);
    expect(latest?.tag).toBe("v0.1.0");
  });

  it("skips nightly, preview, fork, draft and prerelease tags", () => {
    const latest = selectLatestStableRelease([
      release("v0.0.44-nightly.20260917"),
      release("v0.0.44-preview.1"),
      release("v0.0.44-bitsafe.2"),
      release("v0.0.45", { draft: true }),
      release("v0.0.46", { prerelease: true }),
      release("v0.0.43"),
    ]);
    expect(latest?.tag).toBe("v0.0.43");
  });

  it("answers null for a payload holding no stable release", () => {
    expect(selectLatestStableRelease([])).toBeNull();
    expect(selectLatestStableRelease([release("v0.0.44-nightly.1")])).toBeNull();
    expect(selectLatestStableRelease({ message: "rate limit exceeded" })).toBeNull();
  });
});

describe("resolveUpstreamReleaseStatus", () => {
  it("reports a base behind upstream", () => {
    const status = resolveUpstreamReleaseStatus(
      { tag: "v0.0.44", url: "https://example.test", publishedAt: null },
      "v0.0.42",
    );
    expect(status?.isBehind).toBe(true);
  });

  it("reports a base that is current, and one that is ahead", () => {
    const current = resolveUpstreamReleaseStatus(
      { tag: "v0.0.42", url: "https://example.test", publishedAt: null },
      "v0.0.42",
    );
    expect(current?.isBehind).toBe(false);
    const ahead = resolveUpstreamReleaseStatus(
      { tag: "v0.0.41", url: "https://example.test", publishedAt: null },
      "v0.0.42",
    );
    expect(ahead?.isBehind).toBe(false);
  });

  it("answers null without a release or a readable base tag", () => {
    expect(resolveUpstreamReleaseStatus(null, "v0.0.42")).toBeNull();
    expect(
      resolveUpstreamReleaseStatus(
        { tag: "v0.0.44", url: "https://example.test", publishedAt: null },
        "dev",
      ),
    ).toBeNull();
  });
});
