import { describe, it, expect, vi } from "vitest";
import { PermissionRegistry } from "./registry.js";

describe("PermissionRegistry", () => {
  it("resolves allow on respond and clears the pending request", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1");
    expect(reg.respond("sess1", "req1", { behavior: "allow", updatedInput: { x: 1 } })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: "allow", updatedInput: { x: 1 } });
    expect(reg.size()).toBe(0);
    expect(reg.respond("sess1", "req1", { behavior: "allow" })).toBe(false);
  });

  it("accepts numeric requestId on respond key", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1");
    expect(reg.respond("sess1", "req1", { behavior: "deny", message: "no" })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: "deny", message: "no" });
  });

  it("accepts the first response regardless of which subscribed client sent it", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1");
    expect(reg.respond("sess1", "req1", { behavior: "allow" })).toBe(true);
    expect(reg.respond("sess1", "req1", { behavior: "deny" })).toBe(false);
    await expect(p).resolves.toEqual({ behavior: "allow" });
    expect(reg.size()).toBe(0);
  });

  it("keeps a pending request independent of client connection lifecycle", async () => {
    const reg = new PermissionRegistry(5000);
    const first = reg.waitForResponse("sess1", "sdk-request");
    expect(reg.size()).toBe(1);
    expect(reg.respond("sess1", "sdk-request", {
      behavior: "allow",
      updatedPermissions: [{ type: "addRules" }],
    })).toBe(true);
    await expect(first).resolves.toEqual({
      behavior: "allow",
      updatedPermissions: [{ type: "addRules" }],
    });
  });

  it("returns the same promise when the SDK redelivers a request ID", async () => {
    const reg = new PermissionRegistry(5000);
    const first = reg.waitForResponse("sess1", "sdk-request");
    const redelivered = reg.waitForResponse("sess1", "sdk-request");
    expect(redelivered).toBe(first);
    expect(reg.respond("sess1", "sdk-request", { behavior: "allow" })).toBe(true);
    await expect(first).resolves.toEqual({ behavior: "allow" });
  });

  it("cancels a pending request when the SDK abort signal fires", async () => {
    const reg = new PermissionRegistry(5000);
    const abort = new AbortController();
    const decision = reg.waitForResponse("sess1", "req1", { signal: abort.signal });
    abort.abort();
    await expect(decision).resolves.toMatchObject({ behavior: "deny", message: /cancelled/ });
    expect(reg.size()).toBe(0);
  });

  it("denyAllForSession clears pending", async () => {
    const reg = new PermissionRegistry(60_000);
    const p = reg.waitForResponse("sess1", "r1");
    reg.denyAllForSession("sess1");
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(reg.size()).toBe(0);
  });

  it("times out with deny", async () => {
    vi.useFakeTimers();
    const reg = new PermissionRegistry(100);
    const p = reg.waitForResponse("s", "r");
    vi.advanceTimersByTime(150);
    await expect(p).resolves.toMatchObject({ behavior: "deny", message: /timed out/ });
    vi.useRealTimers();
  });
});
