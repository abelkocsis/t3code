/**
 * ThreadForkReactor - Thread fork reaction service interface.
 *
 * Owns the background worker that turns a fork request into a second thread:
 * a worktree of its own, the source history up to the fork point, and a
 * provider binding that resumes the source session from that turn.
 *
 * @module ThreadForkReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadForkReactorShape - Service API for thread fork reactor lifecycle.
 */
export interface ThreadForkReactorShape {
  /**
   * Start the fork reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadForkReactor - Service tag for the thread fork worker.
 */
export class ThreadForkReactor extends Context.Service<ThreadForkReactor, ThreadForkReactorShape>()(
  "t3/orchestration/Services/ThreadForkReactor",
) {}
