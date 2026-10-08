/**
 * Replies in a Slack thread for the Shipping page's re-review requests. T3 holds no Slack
 * credentials; a provider account whose own Slack connection can post does the sending.
 *
 * @module SlackReplyService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  SlackThreadReplyError,
  type SlackThreadReplyInput,
  type SlackThreadReplyResult,
} from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";

export class SlackReplyService extends Context.Service<
  SlackReplyService,
  {
    readonly replyInThread: (
      input: SlackThreadReplyInput,
    ) => Effect.Effect<SlackThreadReplyResult, SlackThreadReplyError>;
  }
>()("t3/slack/SlackReplyService") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const replyInThread: SlackReplyService["Service"]["replyInThread"] = (input) =>
    Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      const sender = instances.find(
        (instance) => instance.enabled && instance.replyInSlackThread !== undefined,
      );
      if (sender?.replyInSlackThread === undefined) {
        return yield* new SlackThreadReplyError({
          reason: "unavailable",
          detail: "No enabled Claude provider on this server can reach Slack.",
        });
      }
      return yield* sender
        .replyInSlackThread({
          channelId: input.thread.channelId,
          threadTs: input.thread.threadTs,
          text: input.text,
        })
        .pipe(
          Effect.mapError(
            (cause) => new SlackThreadReplyError({ reason: "failed", detail: cause.detail }),
          ),
        );
    });

  return SlackReplyService.of({ replyInThread });
});

export const layer = Layer.effect(SlackReplyService, make);

/** Refuses every send, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  SlackReplyService,
  SlackReplyService.of({
    replyInThread: () =>
      Effect.fail(new SlackThreadReplyError({ reason: "unavailable", detail: "Not in tests." })),
  }),
);
