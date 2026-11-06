import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { hasDismissedResumeCompaction } from "@t3tools/client-runtime/state/context-window";
import {
  hasAvailableCompactionProvider,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
  usageLimitRingWindow,
} from "./ContextWindowMeter.logic";

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "" }],
    skills: [],
  };
}

describe("hasAvailableCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("GPT-5.6 Sol");
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });
});

describe("usageLimitRingWindow", () => {
  const window = (
    id: string,
    kind: ServerProviderUsageWindow["kind"],
    usedPercent: number,
  ): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent });
  const report = (
    ...accounts: ReadonlyArray<UsageLimitsReport["accounts"][number]["limits"]>
  ): UsageLimitsReport => ({
    createdAt: "2026-10-28T12:00:00.000Z",
    accounts: accounts.map((limits, index) => ({
      id: `account-${index}`,
      driver: ProviderDriverKind.make("claudeAgent"),
      label: `Account ${index}`,
      limits,
    })),
    notices: [],
  });
  const checkedAt = "2026-10-28T12:00:00.000Z";

  it("shows the session window even when a weekly window is fuller", () => {
    expect(
      usageLimitRingWindow(
        report({
          checkedAt,
          windows: [window("weekly", "weekly", 80), window("session", "session", 41)],
        }),
      )?.id,
    ).toBe("session");
  });

  it("falls back to the most-used window when there is no session window", () => {
    expect(
      usageLimitRingWindow(
        report({
          checkedAt,
          windows: [window("weekly", "weekly", 20), window("monthly", "monthly", 55)],
        }),
      )?.id,
    ).toBe("monthly");
  });

  it("skips accounts that cannot report limits", () => {
    expect(
      usageLimitRingWindow(
        report(
          { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
          { checkedAt, windows: [window("session", "session", 10)] },
        ),
      )?.id,
    ).toBe("session");
    expect(usageLimitRingWindow(report({ checkedAt, windows: [] }))).toBeNull();
    expect(usageLimitRingWindow(null)).toBeNull();
  });
});
