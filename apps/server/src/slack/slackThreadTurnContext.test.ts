import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import { appendSlackThreadTurnContext } from "./slackThreadTurnContext.ts";

const slackThread = {
  url: "https://acme.slack.com/archives/C0123ABCD/p1700000000123456",
  channelId: "C0123ABCD",
  threadTs: "1700000000.123456",
};

describe("appendSlackThreadTurnContext", () => {
  it("leaves the turn alone when no Slack thread is linked", () => {
    expect(appendSlackThreadTurnContext("fix the bug", null)).toBe("fix the bug");
  });

  it("appends the linked thread after the user's text", () => {
    const result = appendSlackThreadTurnContext("what did they say in slack?", slackThread);
    expect(result?.startsWith("what did they say in slack?\n\n[")).toBe(true);
    expect(result).toContain(slackThread.url);
    expect(result).toContain("Never post");
  });

  it("gives an attachment-only turn the note as its text", () => {
    expect(appendSlackThreadTurnContext(undefined, slackThread)).toContain(slackThread.url);
  });

  it("keeps slash commands and over-limit turns unchanged", () => {
    expect(appendSlackThreadTurnContext("/review", slackThread)).toBe("/review");
    const long = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10);
    expect(appendSlackThreadTurnContext(long, slackThread)).toBe(long);
  });
});
