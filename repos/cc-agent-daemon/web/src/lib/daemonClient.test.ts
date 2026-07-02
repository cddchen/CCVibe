import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./daemonClient";

describe("reconnectDelayMs", () => {
  it("exponential backoff capped at 30s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(10)).toBe(30_000);
  });
});