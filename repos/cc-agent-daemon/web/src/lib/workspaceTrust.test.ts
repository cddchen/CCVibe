import { describe, expect, it } from "vitest";
import { parentPath, isTrustError } from "./workspaceTrust";

describe("workspaceTrust", () => {
  it("parentPath returns the parent directory", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/a/b/c/")).toBe("/a/b");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });

  it("isTrustError detects allowlist errors", () => {
    expect(isTrustError("cwd not in workspace allowlist: /x")).toBe(true);
    expect(isTrustError("some other error")).toBe(false);
  });
});