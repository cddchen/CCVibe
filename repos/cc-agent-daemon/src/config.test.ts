import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./config.js";

describe("parseArgs", () => {
  const originalToken = process.env.CC_AGENT_DAEMON_TOKEN;

  beforeEach(() => {
    delete process.env.CC_AGENT_DAEMON_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CC_AGENT_DAEMON_TOKEN;
    else process.env.CC_AGENT_DAEMON_TOKEN = originalToken;
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
    process.env.CC_AGENT_DAEMON_TOKEN = "env-token";
    expect(parseArgs([])).toMatchObject({ token: "env-token", insecureNoAuth: false });
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
