/**
 * To-do list contract.
 *
 * One ordered list per environment, typed by the user. Nothing derives it and
 * nothing reacts to it, so the whole list travels on every read and every
 * write: it is a handful of short lines, and replacing it outright keeps
 * reordering, editing and ticking off on one code path.
 *
 * @module todos
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TodoItem = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  /** A done item stays in the list until the user clears it, so a mis-click costs nothing. */
  done: Schema.Boolean,
  /**
   * UTC instant the item first reached the list. The server stamps it, because
   * the daily summary reports by day and a client clock can be wrong.
   */
  createdAt: Schema.optional(TrimmedNonEmptyString),
  /** UTC instant the user ticked the item off, stamped by the server. Absent while the item is open. */
  doneAt: Schema.optional(TrimmedNonEmptyString),
});
export type TodoItem = typeof TodoItem.Type;

export const TodoList = Schema.Struct({
  /** The user's order. The client shows open items first, then the done ones. */
  items: Schema.Array(TodoItem),
  /** UTC instant of the last write, or of the first read on an empty list. */
  updatedAt: TrimmedNonEmptyString,
});
export type TodoList = typeof TodoList.Type;

/** Replaces the whole list, which covers adding, editing, reordering and ticking off. */
export const TodoListInput = Schema.Struct({
  items: Schema.Array(TodoItem),
});
export type TodoListInput = typeof TodoListInput.Type;

export class TodoError extends Schema.TaggedError<TodoError>()("TodoError", {
  reason: Schema.Literals(["readFailed", "writeFailed"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `To-do list failed (${this.reason}): ${this.detail}`;
  }
}
