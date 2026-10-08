import { describe, expect, it } from "vite-plus/test";

import { buildSlackReplyPrompt, isReplyLinkForThread } from "./ClaudeSlackReply.ts";

const input = {
  channelId: "C0123ABC",
  threadTs: "1700000000.123456",
  text: "Please, review following PRs:\n- https://github.com/acme/web/pull/1",
};

describe("Claude Slack reply", () => {
  it("hands the model the exact text between fixed markers", () => {
    const prompt = buildSlackReplyPrompt(input);
    expect(prompt).toContain("channel_id: C0123ABC");
    expect(prompt).toContain("thread_ts: 1700000000.123456");
    expect(prompt).toContain(`BEGIN\n${input.text}\nEND`);
  });

  it("accepts only a link into the channel it was asked to post in", () => {
    expect(
      isReplyLinkForThread(
        "https://acme.slack.com/archives/C0123ABC/p1700000099000001?thread_ts=1700000000.123456",
        input,
      ),
    ).toBe(true);
    expect(isReplyLinkForThread("https://acme.slack.com/archives/C999/p1", input)).toBe(false);
  });
});
