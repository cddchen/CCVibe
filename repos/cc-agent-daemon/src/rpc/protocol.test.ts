import { describe, expect, it } from "vitest";
import { parseJsonRpcWire } from "./protocol.js";

describe("parseJsonRpcWire", () => {
  it("returns jsonrpc parse errors", () => {
    expect(parseJsonRpcWire("{" )).toEqual({
      error: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
    });
  });

  it("rejects batch requests as invalid request", () => {
    expect(parseJsonRpcWire("[]")).toEqual({
      error: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not supported" } },
    });
  });
});
