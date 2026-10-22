import { describe, expect, it } from "vite-plus/test";

import { parseSlackThreadUrl } from "./slack.ts";

describe("parseSlackThreadUrl", () => {
  it("reads the channel and the message timestamp from a message link", () => {
    expect(
      parseSlackThreadUrl("https://acme.slack.com/archives/C0123ABC/p1700000000123456"),
    ).toEqual({
      url: "https://acme.slack.com/archives/C0123ABC/p1700000000123456",
      channelId: "C0123ABC",
      threadTs: "1700000000.123456",
    });
  });

  it("addresses a link to a reply at the thread it belongs to", () => {
    expect(
      parseSlackThreadUrl(
        "https://acme.slack.com/archives/C0123ABC/p1700000099000001?thread_ts=1700000000.123456&cid=C0123ABC",
      )?.threadTs,
    ).toBe("1700000000.123456");
  });

  it("refuses anything that is not a Slack message link", () => {
    expect(parseSlackThreadUrl("not a url")).toBeNull();
    expect(parseSlackThreadUrl("http://acme.slack.com/archives/C01/p1700000000123456")).toBeNull();
    expect(parseSlackThreadUrl("https://evil.example/archives/C01/p1700000000123456")).toBeNull();
    expect(parseSlackThreadUrl("https://acme.slack.com/archives/C01")).toBeNull();
  });
});
