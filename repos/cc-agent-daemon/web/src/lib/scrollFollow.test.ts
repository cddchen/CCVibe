import { describe, expect, it } from "vitest";
import { followTargetIndex } from "./scrollFollow";

describe("followTargetIndex", () => {
  it("returns the last index when following is on", () => {
    expect(followTargetIndex(5, true)).toBe(4);
  });

  it("returns null when following is off, even with messages", () => {
    expect(followTargetIndex(5, false)).toBeNull();
  });

  it("returns null when there are no messages", () => {
    expect(followTargetIndex(0, true)).toBeNull();
  });

  it("returns null for a negative count guard", () => {
    expect(followTargetIndex(-1, true)).toBeNull();
  });
});
