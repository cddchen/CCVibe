import { describe, expect, it } from "vitest";
import {
  chatNotifyBindOptions,
  liveTurnIsBusy,
  runStateFromDaemonStatus,
  shouldReplaceChatUrlFromInit,
} from "./chatSessionRouting";

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

  it("liveTurnIsBusy covers active runtime states but not idle", () => {
    expect(liveTurnIsBusy("running")).toBe(true);
    expect(liveTurnIsBusy("starting")).toBe(true);
    expect(liveTurnIsBusy("waiting_permission")).toBe(true);
    expect(liveTurnIsBusy("closing")).toBe(true);
    expect(liveTurnIsBusy("idle")).toBe(false);
    expect(liveTurnIsBusy(undefined)).toBe(false);
  });

  it("runStateFromDaemonStatus maps daemon lifecycle to UI state", () => {
    expect(runStateFromDaemonStatus("running")).toBe("running");
    expect(runStateFromDaemonStatus("starting")).toBe("running");
    expect(runStateFromDaemonStatus("waiting_permission")).toBe("running");
    expect(runStateFromDaemonStatus("idle")).toBe("completed");
    expect(runStateFromDaemonStatus("closed")).toBe("completed");
    expect(runStateFromDaemonStatus("error")).toBe("error");
    expect(runStateFromDaemonStatus(undefined)).toBe("completed");
  });
});
