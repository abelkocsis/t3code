/**
 * Client atoms for the fork's per-thread state (see `@t3tools/contracts` fork.ts).
 *
 * The server streams the whole table once and then one row per change. The
 * atom folds that into a map keyed by thread id, which the sidebar joins with
 * upstream's thread shells.
 */
import { WS_METHODS, type ForkThreadState, type ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export type ForkThreadStates = ReadonlyMap<ThreadId, ForkThreadState>;

const EMPTY_STATES: ForkThreadStates = new Map();

export function createForkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    threadStates: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fork:thread-states",
      tag: WS_METHODS.forkThreadStateSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(
            (): ForkThreadStates => EMPTY_STATES,
            (states, event): ForkThreadStates => {
              if (event.type === "snapshot") {
                return new Map(event.states.map((state) => [state.threadId, state]));
              }
              const next = new Map(states);
              next.set(event.state.threadId, event.state);
              return next;
            },
          ),
        ),
    }),
    setThreadFolder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:set-thread-folder",
      tag: WS_METHODS.forkThreadSetFolder,
    }),
    setThreadFactory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:set-thread-factory",
      tag: WS_METHODS.forkThreadSetFactory,
    }),
    setThreadSlackThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:set-thread-slack-thread",
      tag: WS_METHODS.forkThreadSetSlackThread,
    }),
    // Every call posts a message, so a second click while one is in flight
    // joins it rather than posting twice.
    replyInSlackThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fork:reply-in-slack-thread",
      tag: WS_METHODS.forkReplyInSlackThread,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.thread.channelId, input.thread.threadTs]),
      },
    }),
  };
}
