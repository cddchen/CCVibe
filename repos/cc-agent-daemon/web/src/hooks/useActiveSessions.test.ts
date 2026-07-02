import { describe, expect, it } from "vitest";
import { mapActiveSessions } from "./useActiveSessions";

describe("mapActiveSessions", () => {
  it("maps running vs alive statuses", () => {
    const map = mapActiveSessions([
      { sessionId: "a", cwd: "/w", status: "running", subscriberCount: 1 },
      { sessionId: "b", cwd: "/w", status: "starting", subscriberCount: 0 },
      { sessionId: "c", cwd: "/w", status: "interrupted", subscriberCount: 0 },
    ]);
    expect(map).toEqual({
      a: "running",
      b: "alive",
      c: "alive",
    });
  });
});