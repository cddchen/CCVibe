import { describe, expect, it, vi } from "vitest";
import {
  readBooleanPreference,
  readExpandedPreference,
  writeBooleanPreference,
  writeExpandedPreference,
} from "./uiPreferences";

describe("uiPreferences", () => {
  it("reads fallback values when window is unavailable", () => {
    expect(readBooleanPreference("missing", true)).toBe(true);
    expect(readExpandedPreference("missing")).toEqual({});
  });

  it("writes preferences through localStorage when available", () => {
    const store = new Map<string, string>();
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    try {
      writeBooleanPreference("follow", false);
      expect(readBooleanPreference("follow", true)).toBe(false);

      writeExpandedPreference("expanded", { "/repo/a": false, "/repo/b": true });
      expect(readExpandedPreference("expanded")).toEqual({ "/repo/a": false, "/repo/b": true });
    } finally {
      vi.unstubAllGlobals();
      if (originalWindow !== undefined) vi.stubGlobal("window", originalWindow);
    }
  });

  it("ignores invalid expanded preference data", () => {
    const store = new Map<string, string>([["expanded", "not-json"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });

    try {
      expect(readExpandedPreference("expanded")).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
