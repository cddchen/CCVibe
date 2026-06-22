import { describe, expect, it } from "vitest";
import { chatNotifyBindOptions, shouldReplaceChatUrlFromInit } from "./chatSessionRouting";

describe("chatSessionRouting", () => {
  it("keeps existing history-session URLs stable when resumed SDK init arrives", () => {
    expect(shouldReplaceChatUrlFromInit("history-session-id")).toBe(false);
  });

  it("canonicalizes new conversations once SDK init provides a session ID", () => {
    expect(shouldReplaceChatUrlFromInit(null)).toBe(true);
  });

  it("binds to the active runtime session while it is known", () => {
    expect(chatNotifyBindOptions("runtime-id")).toEqual({ sessionIds: ["runtime-id"] });
  });

  it("accepts any notification before a live session exists", () => {
    expect(chatNotifyBindOptions(null)).toEqual({ acceptAny: true });
  });
});
