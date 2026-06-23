import { describe, expect, it } from "vitest";
import { buildWsUrl, defaultWsBase } from "./wsUrl";

describe("defaultWsBase", () => {
  it("uses ws:// for http pages on the same host with port 4733", () => {
    expect(defaultWsBase({ protocol: "http:", hostname: "192.168.1.10" })).toBe("ws://192.168.1.10:4733");
  });

  it("uses wss:// for https pages", () => {
    expect(defaultWsBase({ protocol: "https:", hostname: "example.com" })).toBe("wss://example.com:4733");
  });
});

describe("buildWsUrl", () => {
  it("appends /ws when missing", () => {
    expect(buildWsUrl("ws://host:4733", "")).toBe("ws://host:4733/ws");
  });

  it("does not duplicate /ws when already present", () => {
    expect(buildWsUrl("ws://host:4733/ws", "")).toBe("ws://host:4733/ws");
  });

  it("strips trailing slashes before appending /ws", () => {
    expect(buildWsUrl("ws://host:4733/", "")).toBe("ws://host:4733/ws");
  });

  it("appends a url-encoded token query", () => {
    expect(buildWsUrl("ws://host:4733", "a b/c")).toBe("ws://host:4733/ws?token=a%20b%2Fc");
  });

  it("trims surrounding whitespace from the base", () => {
    expect(buildWsUrl("  ws://host:4733  ", "tok")).toBe("ws://host:4733/ws?token=tok");
  });
});
