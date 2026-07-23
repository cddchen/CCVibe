import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./config.js";

describe("parseArgs", () => {
  const originalToken = process.env.CCLINK_TOKEN;
  const originalAutoReclaimMs = process.env.CCLINK_AUTO_RECLAIM_MS;
  const originalMaxThreads = process.env.CCLINK_MAX_THREADS;

  beforeEach(() => {
    delete process.env.CCLINK_TOKEN;
    delete process.env.CCLINK_AUTO_RECLAIM_MS;
    delete process.env.CCLINK_MAX_THREADS;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CCLINK_TOKEN;
    else process.env.CCLINK_TOKEN = originalToken;
    if (originalAutoReclaimMs === undefined) delete process.env.CCLINK_AUTO_RECLAIM_MS;
    else process.env.CCLINK_AUTO_RECLAIM_MS = originalAutoReclaimMs;
    if (originalMaxThreads === undefined) delete process.env.CCLINK_MAX_THREADS;
    else process.env.CCLINK_MAX_THREADS = originalMaxThreads;
  });

  it("allows 0.0.0.0 binding with an explicit token", () => {
    expect(parseArgs(["--listen", "0.0.0.0:4733", "--token", "secret"])).toMatchObject({
      host: "0.0.0.0",
      port: 4733,
      token: "secret",
      insecureNoAuth: false,
    });
  });

  it("rejects 0.0.0.0 binding without auth", () => {
    expect(() => parseArgs(["--listen", "0.0.0.0:4733", "--insecure-no-auth"])).toThrow(/requires --token/);
  });

  it("allows loopback binding", () => {
    expect(parseArgs(["--listen", "127.0.0.1:4733", "--token", "secret"])).toMatchObject({
      host: "127.0.0.1",
      port: 4733,
      token: "secret",
    });
  });

  it("requires token unless insecure-no-auth is explicit", () => {
    expect(() => parseArgs([])).toThrow(/Missing --token/);
    expect(parseArgs(["--insecure-no-auth"])).toMatchObject({ token: null, insecureNoAuth: true });
  });

  it("uses token from environment", () => {
    process.env.CCLINK_TOKEN = "env-token";
    expect(parseArgs([])).toMatchObject({ token: "env-token", insecureNoAuth: false });
  });

  it("uses default runtime lifecycle settings", () => {
    expect(parseArgs(["--token", "secret"])).toMatchObject({
      autoReclaimMs: 600_000,
      maxThreads: 10,
    });
  });

  it("accepts runtime lifecycle settings from flags", () => {
    expect(parseArgs([
      "--token", "secret",
      "--auto-reclaim-minutes", "2.5",
      "--max-threads", "3",
    ])).toMatchObject({ autoReclaimMs: 150_000, maxThreads: 3 });
  });

  it("rejects invalid runtime lifecycle settings", () => {
    expect(() => parseArgs(["--token", "secret", "--auto-reclaim-minutes", "0"])).toThrow(/invalid auto reclaim/);
    expect(() => parseArgs(["--token", "secret", "--max-threads", "1.5"])).toThrow(/invalid max threads/);
  });

  it("rejects invalid ports", () => {
    expect(() => parseArgs(["--port", "0", "--token", "secret"])).toThrow(/invalid port/);
    expect(() => parseArgs(["--port", "65536", "--token", "secret"])).toThrow(/invalid port/);
    expect(() => parseArgs(["--listen", "127.0.0.1:not-a-port", "--token", "secret"])).toThrow(/invalid port/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--wat", "--token", "secret"])).toThrow(/Unknown argument/);
  });
});
