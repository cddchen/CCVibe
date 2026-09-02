import { MAX_OPAQUE_ID_BYTES } from '../domain/ids.js';

/** Version selected by the first Phase 1 protocol implementation. */
export const PROTOCOL_VERSION = '1.0.0' as const;

/** Maximum UTF-8 size of a client or command/opaque identifier. */
export { MAX_OPAQUE_ID_BYTES };

/** URI segments use the same opaque-ID bound. */
export const MAX_URI_SEGMENT_BYTES = MAX_OPAQUE_ID_BYTES;

/** Maximum UTF-8 size of one resource URI. */
export const MAX_RESOURCE_URI_BYTES = 1024;

/** Maximum UTF-8 size of each initialize clientInfo field. */
export const MAX_CLIENT_INFO_FIELD_BYTES = 128;

/** Maximum number of resources in an initialize/reconnect subscription list. */
export const MAX_SUBSCRIPTIONS = 128;

/** Maximum number of protocol versions offered in initialize. */
export const MAX_PROTOCOL_VERSIONS = 16;

/** Maximum UTF-8 size of one advertised protocol version. */
export const MAX_PROTOCOL_VERSION_BYTES = 32;

/** Maximum UTF-8 size of a JSON-RPC method name. */
export const MAX_METHOD_NAME_BYTES = 128;

/** Maximum UTF-8 size of a host epoch token. */
export const MAX_HOST_EPOCH_BYTES = MAX_OPAQUE_ID_BYTES;

/** Maximum UTF-8 size of a chat/send prompt. */
export const MAX_PROMPT_BYTES = 256 * 1024;

/** Maximum UTF-8 size of one user-supplied workspace path. */
export const MAX_WORKSPACE_PATH_BYTES = 4096;

/** Maximum UTF-8 size accepted for one incoming JSON frame. */
export const MAX_JSON_FRAME_BYTES = 512 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
