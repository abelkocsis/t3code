/**
 * To-do list state for one environment.
 *
 * Every edit replaces the whole list, so the panel holds the result it just
 * sent until the server echoes it. Without that the list would flash back to
 * the stored order for one round trip on each keystroke of a reorder.
 *
 * @module state/todos
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TodoItem, TodoList } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";

const todoListAtom = Atom.family((environmentId: string) =>
  Atom.make((get): AsyncResult.AsyncResult<TodoList, unknown> =>
    get(serverEnvironment.todoList({ environmentId: environmentId as EnvironmentId, input: {} })),
  ).pipe(Atom.withLabel(`web-todos:list:${environmentId}`)),
);

export interface TodoView {
  /** Open items in the user's order, then the done ones, newest tick first. */
  readonly open: readonly TodoItem[];
  readonly done: readonly TodoItem[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly addItem: (text: string) => Promise<void>;
  readonly editItem: (itemId: string, text: string) => Promise<void>;
  readonly setItemDone: (itemId: string, done: boolean) => Promise<void>;
  readonly removeItem: (itemId: string) => Promise<void>;
  /** Stores a new order for the open items. The done ones keep their own. */
  readonly reorderOpen: (items: readonly TodoItem[]) => Promise<void>;
  readonly clearDone: () => Promise<void>;
}

/** Splits the stored list the way the panel draws it. */
export function partitionTodos(items: readonly TodoItem[]): {
  open: readonly TodoItem[];
  done: readonly TodoItem[];
} {
  return {
    open: items.filter((item) => !item.done),
    done: items
      .filter((item) => item.done)
      .sort((left, right) => (right.doneAt ?? "").localeCompare(left.doneAt ?? "")),
  };
}

export function useTodos(environmentId: EnvironmentId | null): TodoView {
  /** The list the panel just sent, shown until the server echoes it. */
  const [pending, setPending] = useState<readonly TodoItem[] | null>(null);

  const result = useAtomValue(
    environmentId === null ? EMPTY_LIST_ATOM : todoListAtom(environmentId),
  ) as AsyncResult.AsyncResult<TodoList, unknown>;

  const stored = Option.getOrNull(AsyncResult.value(result))?.items ?? EMPTY_ITEMS;
  const items = pending ?? stored;

  const refreshList = useAtomQueryRunner(serverEnvironment.todoList, {
    label: "web-todos:refresh",
    refresh: true,
    reportFailure: false,
  });
  const runSetList = useAtomCommand(serverEnvironment.setTodoList, {
    label: "web-todos:set-list",
  });

  const writeItems = useCallback(
    async (next: readonly TodoItem[]) => {
      if (environmentId === null) return;
      setPending(next);
      try {
        await runSetList({ environmentId, input: { items: next } });
        await refreshList({ environmentId, input: {} });
      } finally {
        setPending(null);
      }
    },
    [environmentId, refreshList, runSetList],
  );

  const addItem = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return Promise.resolve();
      // The clock keeps a new item distinct from every stored one, and the
      // list is typed by one person, so a collision is not reachable.
      const item: TodoItem = { itemId: `todo-${Date.now()}`, text: trimmed, done: false };
      return writeItems([...items, item]);
    },
    [items, writeItems],
  );

  const editItem = useCallback(
    (itemId: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return Promise.resolve();
      return writeItems(
        items.map((item) => (item.itemId === itemId ? { ...item, text: trimmed } : item)),
      );
    },
    [items, writeItems],
  );

  const setItemDone = useCallback(
    (itemId: string, done: boolean) =>
      writeItems(
        items.map((item) =>
          item.itemId === itemId
            ? done
              ? { ...item, done: true, doneAt: new Date().toISOString() }
              : { itemId: item.itemId, text: item.text, done: false }
            : item,
        ),
      ),
    [items, writeItems],
  );

  const removeItem = useCallback(
    (itemId: string) => writeItems(items.filter((item) => item.itemId !== itemId)),
    [items, writeItems],
  );

  const reorderOpen = useCallback(
    (nextOpen: readonly TodoItem[]) => writeItems([...nextOpen, ...items.filter((i) => i.done)]),
    [items, writeItems],
  );

  const clearDone = useCallback(
    () => writeItems(items.filter((item) => !item.done)),
    [items, writeItems],
  );

  const { open, done } = useMemo(() => partitionTodos(items), [items]);

  return {
    open,
    done,
    isLoading: result.waiting && pending === null,
    error: result._tag === "Failure" ? "The to-do list could not be read." : null,
    addItem,
    editItem,
    setItemDone,
    removeItem,
    reorderOpen,
    clearDone,
  };
}

/** A stable empty list, so a loading panel does not invalidate every callback. */
const EMPTY_ITEMS: readonly TodoItem[] = [];

/** Placeholder for a panel rendered before any environment is connected. */
const EMPTY_LIST_ATOM = Atom.make((): AsyncResult.AsyncResult<TodoList, unknown> =>
  AsyncResult.initial(),
).pipe(Atom.withLabel("web-todos:list:none"));
