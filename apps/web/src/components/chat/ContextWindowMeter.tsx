import type {
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
  UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LimitWindowsStacked } from "../usage/UsageLimits";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
  usageLimitRingWindow,
} from "./ContextWindowMeter.logic";
import { usePrimarySettings } from "../../hooks/useSettings";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  /**
   * Inputs for the selected provider's subscription limits, shown under the
   * context bar. Omit them, or pass a provider that reports none, to hide the section.
   */
  usageLimitProviderInstanceId?: ProviderInstanceId | null;
  providers?: ReadonlyArray<ServerProvider>;
  usageLimitSources?: UsageLimitSourceSnapshots;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    modelDisplayName,
    usageLimitProviderInstanceId,
    providers,
    usageLimitSources,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  // The limits are collected once per opening rather than on every render or
  // every second: the collection walks every provider and hub account, and a
  // bar that repaints as the clock ticks costs a frame on every high-refresh
  // display. "resets in 3h 2m" is no less true a minute later.
  const [usageLimits, setUsageLimits] = useState<{
    readonly report: UsageLimitsReport;
    readonly now: number;
  } | null>(null);
  const collectUsageLimits = () => {
    if (!usageLimitProviderInstanceId || !providers || !usageLimitSources) return null;
    const now = Date.now();
    const report = collectProviderUsageLimits(
      usageLimitProviderInstanceId,
      providers,
      usageLimitSources,
      now,
    );
    return report && report.accounts.length > 0 ? { report, now } : null;
  };
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const usageColor = meterColor(normalizedPercentage);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setUsageLimits(collectUsageLimits());
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <MeterRing percent={normalizedPercentage} color={usageColor} />
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width={usageLimits ? "md" : "sm"}
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {usageLimits ? (
            <UsageLimitsSummary report={usageLimits.report} now={usageLimits.now} />
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function meterColor(usedPercent: number): string {
  return usedPercent > 90
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
}

function MeterRing({ percent, color }: { readonly percent: number; readonly color: string }) {
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  return (
    <span className="relative flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          className="stroke-muted-foreground/24"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
    </span>
  );
}

/**
 * A thread with no messages has no context to measure, so its ring shows the
 * session limit instead, read the same way as the usage bars (used or left).
 */
export function UsageLimitsMeter(props: {
  usageLimitProviderInstanceId: ProviderInstanceId;
  providers: ReadonlyArray<ServerProvider>;
  usageLimitSources: UsageLimitSourceSnapshots;
}) {
  const { usageLimitProviderInstanceId, providers, usageLimitSources } = props;
  const fillUsed = usePrimarySettings((settings) => settings.usageBarsFillUsed);
  const [opened, setOpened] = useState<{
    readonly report: UsageLimitsReport;
    readonly now: number;
  } | null>(null);
  // `now` only stamps the report's createdAt, so a constant keeps render pure.
  const ringWindow = usageLimitRingWindow(
    collectProviderUsageLimits(usageLimitProviderInstanceId, providers, usageLimitSources, 0),
  );
  if (!ringWindow) return null;
  const remaining = remainingPercent(ringWindow);
  const fill = fillUsed ? 100 - remaining : remaining;
  const reading = fillUsed ? `${100 - remaining}% used` : `${remaining}% left`;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        const now = Date.now();
        const report = collectProviderUsageLimits(
          usageLimitProviderInstanceId,
          providers,
          usageLimitSources,
          now,
        );
        setOpened(report && report.accounts.length > 0 ? { report, now } : null);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={`${ringWindow.label} limit ${reading}`}
          >
            <MeterRing percent={fill} color={meterColor(100 - remaining)} />
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="md"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          {opened ? <UsageLimitsSummary report={opened.report} now={opened.now} /> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}

/**
 * The signed-in account's subscription windows, under the context bar. Both
 * answer "how much room is left", so the user reads them in one place;
 * `/usage-limits` and Usage → Limits still show the same numbers with the
 * account details and reset credits this popover has no room for.
 */
function UsageLimitsSummary({
  report,
  now,
}: {
  readonly report: UsageLimitsReport;
  readonly now: number;
}) {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 ? first : null;
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border/60 pt-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">Usage limits</span>
        {single?.plan ? (
          <span className="truncate text-secondary-label text-2xs">{single.plan}</span>
        ) : null}
      </div>
      {report.accounts.map((account) => {
        const notice = limitsNotice(account.limits);
        return (
          <div key={account.id} className="flex min-w-0 flex-col gap-1">
            {single === null ? (
              <span className="truncate text-secondary-label text-2xs">
                {[account.displayName ?? account.label, account.plan].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {notice ? (
              <span className="text-secondary-label text-2xs">{notice}</span>
            ) : (
              <LimitWindowsStacked
                driver={account.driver}
                windows={account.limits.windows}
                now={now}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
