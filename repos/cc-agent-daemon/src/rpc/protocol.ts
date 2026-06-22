export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  UNAUTHORIZED: -32001,
  INTERNAL: -32603,
} as const;

export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

export function jsonRpcError(id: number | string | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function parseJsonRpcWire(raw: string): { request: JsonRpcRequest } | { error: JsonRpcError } {
  try {
    const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(parsed)) {
      return { error: jsonRpcError(null, RPC_ERROR.INVALID_REQUEST, "batch requests are not supported") };
    }
    if (!parsed || typeof parsed !== "object") {
      return { error: jsonRpcError(null, RPC_ERROR.INVALID_REQUEST, "invalid request") };
    }
    return { request: parsed };
  } catch {
    return { error: jsonRpcError(null, RPC_ERROR.PARSE, "parse error") };
  }
}