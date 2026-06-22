import { describe, it, expect } from "vitest";
import { validateToken, extractTokenFromUrl, generateToken } from "./auth.js";

describe("auth", () => {
  it("validateToken allows when expected is null", () => {
    expect(validateToken(null, undefined)).toBe(true);
  });

  it("validateToken matches secret", () => {
    expect(validateToken("abc", "abc")).toBe(true);
    expect(validateToken("abc", "wrong")).toBe(false);
  });

  it("extractTokenFromUrl", () => {
    expect(extractTokenFromUrl("/ws?token=xyz")).toBe("xyz");
  });

  it("generateToken is hex", () => {
    expect(generateToken()).toMatch(/^[a-f0-9]{64}$/);
  });
});