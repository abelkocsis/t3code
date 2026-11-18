import type { StandupItem } from "@t3tools/contracts";

export interface StandupEditSet {
  readonly edited: ReadonlyArray<{ readonly before: string; readonly after: string }>;
  readonly removed: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly finalOrder: ReadonlyArray<string>;
}

/**
 * What the user changed on a day, read from the stored items alone.
 *
 * An item with no `generatedText` was stored before that field existed, so it
 * counts as unchanged unless it is manual. The order is always reported, since
 * the model never sees a drag.
 */
export function collectStandupEdits(items: ReadonlyArray<StandupItem>): StandupEditSet {
  const edited: Array<{ before: string; after: string }> = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const item of items) {
    if (item.source === "manual") {
      if (!item.excluded) added.push(item.text);
      continue;
    }
    if (item.excluded) {
      removed.push(item.generatedText ?? item.text);
      continue;
    }
    if (item.generatedText !== undefined && item.generatedText !== item.text) {
      edited.push({ before: item.generatedText, after: item.text });
    }
  }
  return {
    edited,
    removed,
    added,
    finalOrder: items.filter((item) => !item.excluded).map((item) => item.text),
  };
}

export interface InstructedItem {
  readonly itemId: string;
  readonly text: string;
  readonly source: string;
  readonly excluded: boolean;
}

/**
 * A row that keeps its id keeps its record. Reworded under the same id, it keeps
 * its `generatedText`, so an instruction counts as an edit the learn step sees.
 * A row with a new id is fresh model wording. A dropped row is gone, manual or
 * not: the user has one undo.
 */
export function reconcileInstructedItems(input: {
  readonly previous: ReadonlyArray<StandupItem>;
  readonly instructed: ReadonlyArray<InstructedItem>;
  readonly newId: (index: number) => string;
}): ReadonlyArray<StandupItem> {
  const byId = new Map(input.previous.map((item) => [item.itemId, item]));
  const used = new Set<string>();
  return input.instructed.map((row, index): StandupItem => {
    const kept = byId.get(row.itemId);
    if (kept !== undefined && !used.has(row.itemId)) {
      used.add(row.itemId);
      return { ...kept, text: row.text, excluded: row.excluded };
    }
    const source = isItemSource(row.source) ? row.source : "thread";
    return {
      itemId: input.newId(index),
      text: row.text,
      source,
      excluded: row.excluded,
      ...(source === "manual" ? {} : { generatedText: row.text }),
    };
  });
}

const ITEM_SOURCES = new Set(["thread", "commit", "pullRequest", "issue", "cliSession", "manual"]);

function isItemSource(value: string): value is StandupItem["source"] {
  return ITEM_SOURCES.has(value);
}
