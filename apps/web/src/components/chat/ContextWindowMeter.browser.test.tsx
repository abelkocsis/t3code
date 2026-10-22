import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { render } from "../../../test/render";

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select({ timestampFormat: "24h", usagePaceIncludesWeekends: true }),
}));

import { ContextWindowMeter } from "./ContextWindowMeter";

const codex = ProviderInstanceId.make("codex");

const usage = {
  usedTokens: 40_000,
  maxTokens: 200_000,
  usedPercentage: 20,
  remainingPercentage: 80,
  remainingTokens: 160_000,
  updatedAt: "2026-09-03T12:00:00.000Z",
} as unknown as ContextWindowSnapshot;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", label: "Pro" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const withLimits = provider({
  usageLimits: {
    checkedAt: "2026-09-03T11:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10 },
    ],
  },
});

it("shows the selected provider's limit windows under the context bar", async () => {
  await using screen = await render(
    <ContextWindowMeter
      usage={usage}
      usageLimitProviderInstanceId={codex}
      providers={[withLimits]}
      usageLimitSources={[]}
    />,
  );
  await userEvent.hover(screen.container.querySelector("button")!);
  await expect.element(page.getByText("Usage limits", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Pro", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: /^Session: 60% left/ })).toBeVisible();
  await expect.element(page.getByRole("img", { name: /^Weekly: 90% left/ })).toBeVisible();
});

it("keeps the popover to the context window when the provider reports no limits", async () => {
  await using screen = await render(
    <ContextWindowMeter
      usage={usage}
      usageLimitProviderInstanceId={codex}
      providers={[provider({})]}
      usageLimitSources={[]}
    />,
  );
  await userEvent.hover(screen.container.querySelector("button")!);
  await expect.element(page.getByText("Context Window", { exact: true })).toBeVisible();
  expect(page.getByText("Usage limits", { exact: true }).query()).toBeNull();
});
