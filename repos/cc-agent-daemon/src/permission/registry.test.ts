import { describe, it, expect, vi } from "vitest";
import { PermissionRegistry } from "./registry.js";

describe("PermissionRegistry", () => {
  it("resolves allow on respond and clears the pending request", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1", "conn1");
    expect(reg.respond("sess1", "req1", "conn1", { behavior: "allow", updatedInput: { x: 1 } })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: "allow", updatedInput: { x: 1 } });
    expect(reg.size()).toBe(0);
    expect(reg.respond("sess1", "req1", "conn1", { behavior: "allow" })).toBe(false);
  });

  it("accepts numeric requestId on respond key", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1", "conn1");
    expect(reg.respond("sess1", "req1", "conn1", { behavior: "deny", message: "no" })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: "deny", message: "no" });
  });

  it("rejects responses from non-owner connections", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1", "conn1");
    expect(reg.respond("sess1", "req1", "conn2", { behavior: "allow" })).toBe(false);
    reg.denyAllForConnection("conn1");
    await expect(p).resolves.toMatchObject({ behavior: "deny", message: /disconnected/ });
  });

  it("denyAllForConnection clears owned pending", async () => {
    const reg = new PermissionRegistry(5000);
    const p = reg.waitForResponse("sess1", "req1", "conn1");
    reg.denyAllForConnection("conn1");
    await expect(p).resolves.toMatchObject({ behavior: "deny", message: /disconnected/ });
    expect(reg.size()).toBe(0);
  });

  it("denyAllForSession clears pending", async () => {
    const reg = new PermissionRegistry(60_000);
    const p = reg.waitForResponse("sess1", "r1", "conn1");
    reg.denyAllForSession("sess1");
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(reg.size()).toBe(0);
  });

  it("times out with deny", async () => {
    vi.useFakeTimers();
    const reg = new PermissionRegistry(100);
    const p = reg.waitForResponse("s", "r", "conn1");
    vi.advanceTimersByTime(150);
    await expect(p).resolves.toMatchObject({ behavior: "deny", message: /timed out/ });
    vi.useRealTimers();
  });
});