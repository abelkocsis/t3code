import { memo, type PointerEventHandler, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import type { ThreadScheduledMessage } from "@t3tools/contracts";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { snoozeWakeDescription } from "../Sidebar.snooze";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "./composerScheduleTime";
import { composerFloatingLayerProps } from "./composerEventScope";

/** What ChatView hands the composer so it can park a message for later. */
export interface ComposerMessageScheduling {
  readonly pending: ThreadScheduledMessage | null;
  readonly disabledReason: string | null;
  readonly resolveDefaultDueAt: () => string;
  readonly onSchedule: (dueAt: string) => void;
  readonly onCancel: () => void;
}

interface ComposerScheduleActionProps {
  compact: boolean;
  /** The message already parked on this thread, if any. */
  pending: ThreadScheduledMessage | null;
  /** Why scheduling is unavailable right now; null means it is available. */
  disabledReason: string | null;
  /** Read at open time so the quota reset is current, not the one from mount. */
  resolveDefaultDueAt: () => string;
  onSchedule: (dueAt: string) => void;
  onCancel: () => void;
  preserveComposerFocusOnPointerDown?: boolean;
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerScheduleAction = memo(function ComposerScheduleAction({
  compact,
  pending,
  disabledReason,
  resolveDefaultDueAt,
  onSchedule,
  onCancel,
  preserveComposerFocusOnPointerDown = false,
}: ComposerScheduleActionProps) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const isDisabled = disabledReason !== null && pending === null;
  const pendingLabel =
    pending === null ? null : snoozeWakeDescription(pending.dueAt, new Date(), timestampFormat);
  // The minute tick flips the pill to "waiting" once the due time passes.
  const nowMinute = useNowMinute();
  const overdue = pending !== null && Date.parse(pending.dueAt) <= Date.parse(`${nowMinute}Z`);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setValue(toDateTimeLocalValue(pending?.dueAt ?? resolveDefaultDueAt()));
      setError(null);
    }
    setOpen(nextOpen);
  };

  const submit = () => {
    const dueAt = fromDateTimeLocalValue(value, Date.now());
    if (dueAt === null) {
      setError("Pick a time in the future.");
      return;
    }
    onSchedule(dueAt);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size={pending === null ? "icon-sm" : "sm"}
                  variant="ghost"
                  className={cn(
                    "rounded-full text-muted-foreground",
                    pending !== null && (compact ? "px-2" : "px-2.5"),
                  )}
                  disabled={isDisabled}
                  aria-label={
                    pending === null
                      ? (disabledReason ?? "Schedule message")
                      : `Message scheduled for ${pendingLabel}`
                  }
                  {...pointerFocusProps}
                />
              }
            >
              <AlarmClockIcon className="size-3.5" />
              {pending === null ? null : (
                <span className="text-xs tabular-nums">
                  {overdue ? "Waiting to send" : pendingLabel}
                </span>
              )}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="top">
          {pending === null
            ? (disabledReason ?? "Schedule this message")
            : overdue
              ? `Past due since ${pendingLabel}`
              : `Scheduled for ${pendingLabel}`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="top" className="w-72" {...composerFloatingLayerProps}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-medium text-sm">
              {pending === null ? "Send later" : "Scheduled message"}
            </span>
            <span className="text-muted-foreground text-xs">
              {overdue
                ? "Past due. It goes out once the agent is idle, nothing waits on you, and no background work runs."
                : "T3 Code sends it at this time, as long as this server is running."}
            </span>
          </div>
          {pending === null ? null : (
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 px-2 py-1.5 text-xs">
              {pending.text}
            </p>
          )}
          <Input
            type="datetime-local"
            size="sm"
            nativeInput
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            aria-label="Send at"
          />
          {error === null ? null : <span className="text-destructive text-xs">{error}</span>}
          <div className="flex items-center justify-between gap-2">
            {pending === null ? (
              <span className="text-muted-foreground text-xs">
                The draft moves out of the composer.
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="px-2 text-destructive"
                onClick={() => {
                  onCancel();
                  setOpen(false);
                }}
              >
                Cancel send
              </Button>
            )}
            <Button type="button" size="sm" onClick={submit}>
              {pending === null ? "Schedule" : "Update"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
