/**
 * JSON-RPC 2.0 framing. Transports carry one JSON object per line (NDJSON), so
 * the same framing works over stdio, a Unix socket, or a WebSocket.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application errors. */
  NotInitialized: -32000,
  SessionNotFound: -32001,
  SessionBusy: -32002,
  ProviderUnavailable: -32003,
  BudgetExceeded: -32004,
  Unauthorized: -32005,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m && m.id !== undefined;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !('method' in m) && 'id' in m;
}
