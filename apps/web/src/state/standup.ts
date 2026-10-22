/**
 * Daily summary state for one environment.
 *
 * The summary spans every project on one machine, so it is not merged across
 * environments. The panel reads the environment the active thread belongs to.
 *
 * Generating costs provider tokens, so it only ever happens on an explicit act:
 * opening the panel on a day with work and no stored summary, or pressing
 * Regenerate. Switching to another date never generates on its own.
 *
 * @module state/standup
 */
import { useAtomValue } from "@effect/atom-react";
import { StandupDay } from "@t3tools/contracts";
import type { EnvironmentId, StandupItem, StandupState, StandupSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";

/**
 * The zone the user experiences their day in, which the server buckets by.
 * Read once: a machine does not change zone mid-session.
 */
export const REPORTING_TIME_ZONE: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const standupStateAtom = Atom.family((key: string) =>
  Atom.make((get): AsyncResult.AsyncResult<StandupState, unknown> => {
    const { environmentId, input } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      input: { timeZone: string; day?: StandupDay };
    };
    return get(serverEnvironment.standupState({ environmentId, input }));
  }).pipe(Atom.withLabel(`web-standup:state:${key}`)),
);

export interface StandupView {
  /** The day on screen, or `null` before the server has named one. */
  readonly day: StandupDay | null;
  readonly storedDays: readonly StandupDay[];
  readonly summary: StandupSummary | null;
  readonly hasWork: boolean;
  readonly isLoading: boolean;
  readonly isGenerating: boolean;
  readonly error: string | null;
  /** The bullets the user kept, as the text they would paste. */
  readonly text: string;
  readonly showDay: (day: string) => void;
  readonly generate: () => Promise<void>;
  readonly setItemExcluded: (itemId: string, excluded: boolean) => Promise<void>;
  /** Rewrites one bullet. Blank text is ignored; removing is `setItemExcluded`. */
  readonly setItemText: (itemId: string, text: string) => Promise<void>;
  readonly addItem: (text: string) => Promise<void>;
  /** Stores a new bullet order. The panel shows the drag result immediately. */
  readonly reorderItems: (items: readonly StandupItem[]) => Promise<void>;
  readonly save: () => Promise<void>;
}

/** Renders the kept items the way the user pastes them into a chat message. */
export function formatStandupText(items: readonly StandupItem[]): string {
  return items
    .filter((item) => !item.excluded)
    .map((item) => `• ${item.text}`)
    .join("\n");
}

/**
 * The same bullets as an HTML list, for the `text/html` clipboard flavor.
 *
 * Slack's composer pastes a plain-text bullet character as literal text, but
 * turns a pasted `<ul>` into one of its own lists. Carrying both flavors keeps
 * the plain text for terminals and editors and gives Slack real bullets.
 */
export function formatStandupHtml(items: readonly StandupItem[]): string {
  const rows = items
    .filter((item) => !item.excluded)
    .map((item) => `<li>${escapeHtml(item.text)}</li>`)
    .join("");
  return `<ul>${rows}</ul>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function useStandup(environmentId: EnvironmentId | null): StandupView {
  const timeZone = REPORTING_TIME_ZONE;
  const [requestedDay, setRequestedDay] = useState<StandupDay | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const input = requestedDay === null ? { timeZone } : { timeZone, day: requestedDay };
  const key = environmentId === null ? null : JSON.stringify({ environmentId, input });

  const result = useAtomValue(
    key === null ? EMPTY_STATE_ATOM : standupStateAtom(key),
  ) as AsyncResult.AsyncResult<StandupState, unknown>;

  const state = Option.getOrNull(AsyncResult.value(result));
  const day = state?.day ?? requestedDay;

  const refreshState = useAtomQueryRunner(serverEnvironment.standupState, {
    label: "web-standup:refresh",
    refresh: true,
    reportFailure: false,
  });
  const runGenerate = useAtomCommand(serverEnvironment.generateStandupSummary, {
    label: "web-standup:generate",
  });
  const runUpdateItems = useAtomCommand(serverEnvironment.updateStandupItems, {
    label: "web-standup:update-items",
  });
  const runSave = useAtomCommand(serverEnvironment.saveStandupSummary, {
    label: "web-standup:save",
  });

  const reload = async () => {
    if (environmentId === null) return;
    await refreshState({ environmentId, input });
  };

  const generate = async () => {
    if (environmentId === null || day === null) return;
    setIsGenerating(true);
    try {
      await runGenerate({ environmentId, input: { day, timeZone } });
    } finally {
      setIsGenerating(false);
    }
    await reload();
  };

  const writeItems = async (items: readonly StandupItem[]) => {
    if (environmentId === null || day === null) return;
    await runUpdateItems({ environmentId, input: { day, timeZone, items } });
    await reload();
  };

  const items = state?.summary?.items ?? EMPTY_ITEMS;

  const setItemExcluded = (itemId: string, excluded: boolean) =>
    writeItems(items.map((item) => (item.itemId === itemId ? { ...item, excluded } : item)));

  // The source stays as it was, so a regeneration feeds the edited wording to
  // the model as a kept item instead of pinning it verbatim like a typed one.
  const setItemText = (itemId: string, text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return Promise.resolve();
    const current = items.find((item) => item.itemId === itemId);
    if (current === undefined || current.text === trimmed) return Promise.resolve();
    return writeItems(
      items.map((item) => (item.itemId === itemId ? { ...item, text: trimmed } : item)),
    );
  };

  const addItem = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return Promise.resolve();
    return writeItems([
      ...items,
      {
        itemId: newManualItemId(),
        text: trimmed,
        source: "manual",
        excluded: false,
      },
    ]);
  };

  const text = formatStandupText(items);

  const save = async () => {
    if (environmentId === null || day === null) return;
    await runSave({ environmentId, input: { day, timeZone, text } });
    await reload();
  };

  return {
    day,
    storedDays: state?.storedDays ?? EMPTY_DAYS,
    summary: state?.summary ?? null,
    hasWork: state?.hasWork ?? false,
    isLoading: result.waiting,
    isGenerating,
    error: result._tag === "Failure" ? "The daily summary could not be read." : null,
    text,
    showDay: (next) => setRequestedDay(StandupDay.make(next)),
    generate,
    setItemExcluded,
    setItemText,
    addItem,
    reorderItems: writeItems,
    save,
  };
}

/**
 * The clock keeps a typed item distinct from a regenerated one, whose ids
 * restart at zero on every run. Kept out of the hook so the compiler sees no
 * impure call in render scope.
 */
function newManualItemId(): string {
  return `manual-${Date.now()}`;
}

const EMPTY_ITEMS: readonly StandupItem[] = [];
const EMPTY_DAYS: readonly StandupDay[] = [];

/** Placeholder for a panel rendered before any environment is connected. */
const EMPTY_STATE_ATOM = Atom.make((): AsyncResult.AsyncResult<StandupState, unknown> =>
  AsyncResult.initial(),
).pipe(Atom.withLabel("web-standup:state:none"));
