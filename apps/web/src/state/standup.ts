/**
 * Daily summary state for one environment.
 *
 * The summary spans every project on one machine, so unlike usage it is not
 * merged across environments. The panel reads the environment the active thread
 * belongs to.
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
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";

/**
 * The zone the user experiences their day in, which the server buckets by.
 *
 * Read once: a machine does not change zone mid-session, and a stable value
 * keeps every callback below from being rebuilt on each render.
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
  readonly addItem: (text: string) => Promise<void>;
  /** Stores a new bullet order. The panel shows the drag result immediately. */
  readonly reorderItems: (items: readonly StandupItem[]) => Promise<void>;
  readonly save: () => Promise<void>;
}

/** Renders the kept items the way the user pastes them into Slack. */
export function formatStandupText(items: readonly StandupItem[]): string {
  return items
    .filter((item) => !item.excluded)
    .map((item) => `• ${item.text}`)
    .join("\n");
}

export function useStandup(environmentId: EnvironmentId | null): StandupView {
  const timeZone = REPORTING_TIME_ZONE;
  const [requestedDay, setRequestedDay] = useState<StandupDay | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const key = useMemo(
    () =>
      environmentId === null
        ? null
        : JSON.stringify({
            environmentId,
            input: requestedDay === null ? { timeZone } : { timeZone, day: requestedDay },
          }),
    [environmentId, requestedDay],
  );

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

  const reload = useCallback(async () => {
    if (environmentId === null) return;
    await refreshState({
      environmentId,
      input: requestedDay === null ? { timeZone } : { timeZone, day: requestedDay },
    });
  }, [environmentId, refreshState, requestedDay]);

  const generate = useCallback(async () => {
    if (environmentId === null || day === null) return;
    setIsGenerating(true);
    try {
      await runGenerate({ environmentId, input: { day, timeZone } });
    } finally {
      setIsGenerating(false);
    }
    await reload();
  }, [day, environmentId, reload]);

  const writeItems = useCallback(
    async (items: readonly StandupItem[]) => {
      if (environmentId === null || day === null) return;
      await runUpdateItems({ environmentId, input: { day, timeZone, items } });
      await reload();
    },
    [day, environmentId, reload, runUpdateItems],
  );

  const currentItems = state?.summary?.items ?? EMPTY_ITEMS;

  const setItemExcluded = useCallback(
    (itemId: string, excluded: boolean) =>
      writeItems(
        currentItems.map((item) => (item.itemId === itemId ? { ...item, excluded } : item)),
      ),
    [currentItems, writeItems],
  );

  const addItem = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return Promise.resolve();
      return writeItems([
        ...currentItems,
        {
          // The clock keeps a typed item distinct from a regenerated one,
          // whose ids restart at zero on every run.
          itemId: `manual-${Date.now()}`,
          text: trimmed,
          source: "manual",
          excluded: false,
        },
      ]);
    },
    [currentItems, writeItems],
  );

  const items = currentItems;
  const text = formatStandupText(items);

  const save = useCallback(async () => {
    if (environmentId === null || day === null) return;
    await runSave({
      environmentId,
      input: { day, timeZone, text: formatStandupText(items) },
    });
    await reload();
  }, [day, environmentId, items, reload, runSave]);

  const showDay = useCallback((next: string) => setRequestedDay(StandupDay.make(next)), []);

  return {
    day,
    storedDays: state?.storedDays ?? [],
    summary: state?.summary ?? null,
    hasWork: state?.hasWork ?? false,
    isLoading: result.waiting,
    isGenerating,
    error: result._tag === "Failure" ? "The daily summary could not be read." : null,
    text,
    showDay,
    generate,
    setItemExcluded,
    addItem,
    reorderItems: writeItems,
    save,
  };
}

/** A stable empty list, so an unread day does not invalidate every callback. */
const EMPTY_ITEMS: readonly StandupItem[] = [];

/** Placeholder for a panel rendered before any environment is connected. */
const EMPTY_STATE_ATOM = Atom.make((): AsyncResult.AsyncResult<StandupState, unknown> =>
  AsyncResult.initial(),
).pipe(Atom.withLabel("web-standup:state:none"));
