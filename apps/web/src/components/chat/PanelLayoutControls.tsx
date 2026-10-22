import {
  CalendarDaysIcon,
  CoffeeIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SquareMenuIcon,
} from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo, type ReactElement } from "react";

import { isElectron } from "../../env";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { useStepAwayStore } from "../../stepAwayStore";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  /**
   * Toggles the to-do list tab. Absent on a surface that has no right panel to
   * open it in, which is why the control is not offered there.
   */
  onOpenTodos?: (() => void) | undefined;
  todosOpen?: boolean;
  /** Toggles the daily summary tab. Absent for the same reason the list's is. */
  onOpenStandup?: (() => void) | undefined;
  standupOpen?: boolean;
  /** Opens the thread in its own window. Absent where a thread cannot have one. */
  onOpenInWindow?: (() => void) | undefined;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  showTerminalControl = true,
  showRightPanelControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  onOpenTodos,
  todosOpen = false,
  onOpenStandup,
  standupOpen = false,
  onOpenInWindow,
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <SquareMenuIcon className="size-4" />
    </Toggle>
  );
  const threadPanelTooltip = (trigger: ReactElement) => (
    <Tooltip>
      <TooltipTrigger
        render={trigger}
        {...(threadPanelPresentation === "popover" ? {} : { onClick: onToggleThreadPanel })}
      />
      <TooltipPopup side="bottom">
        Toggle thread details
        {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <StepAwayToggle />
      {onOpenTodos ? <TodoToggle open={todosOpen} onOpen={onOpenTodos} /> : null}
      {onOpenStandup ? <StandupToggle open={standupOpen} onOpen={onOpenStandup} /> : null}
      {showThreadPanelControl
        ? threadPanelPresentation === "popover"
          ? threadPanelTooltip(
              <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />,
            )
          : threadPanelTooltip(threadPanelToggle)
        : null}
      {onOpenInWindow ? <OpenInWindowControl onOpen={onOpenInWindow} /> : null}
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {showRightPanelControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label="Toggle right panel"
              data-right-panel-toggle
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : rightPanelUnavailableLabel}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});

/**
 * Step away mode: the overlay window at a size that reads from across a room.
 *
 * Desktop only, because the overlay is an Electron window. A browser tab has
 * nothing to grow, so the control is not offered there rather than being
 * offered and doing nothing.
 */
function StepAwayToggle() {
  const active = useStepAwayStore((state) => state.active);
  const toggle = useStepAwayStore((state) => state.toggle);
  if (!isElectron) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={active}
          onPressedChange={toggle}
          aria-label={active ? "Leave step away mode" : "Step away mode"}
          variant="ghost"
          size="sm"
        >
          <CoffeeIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {active
          ? "Leave step away mode"
          : "Step away mode: a large overlay you can read from across the room"}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Opens the to-do list, which spans the whole environment rather than the
 * thread it is opened from. A second press closes the panel while the list is
 * the tab on screen.
 *
 * It sits next to step away rather than only inside the right panel's "+" menu
 * because the list is what the user reaches for between threads.
 */
function TodoToggle({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={onOpen}
          aria-label="To-do list"
          variant="ghost"
          size="sm"
        >
          <ListChecksIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Your to-do list</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Opens the daily summary beside the thread, and closes the panel when the
 * summary is the tab on screen. Like the to-do list it spans every project in
 * the environment, so it lives in this row and not in the thread's own tabs.
 * Offered on the web as well as the desktop, unlike step away, because nothing
 * about it needs an Electron window.
 */
function StandupToggle({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={onOpen}
          aria-label="Daily summary"
          variant="ghost"
          size="sm"
        >
          <CalendarDaysIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Daily summary for your standup</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Opens the thread in its own window, beside the main one. It is an action, but
 * it uses the row's toggle so that it looks like its neighbours.
 */
function OpenInWindowControl({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={false}
          onPressedChange={onOpen}
          aria-label="Open in new window"
          variant="ghost"
          size="sm"
        >
          <ExternalLinkIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Open in new window</TooltipPopup>
    </Tooltip>
  );
}

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            <MorphIcon className="size-4" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
