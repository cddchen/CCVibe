/** Sentinel used for every secret-like or raw agent value in structured logs. */
export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED = REDACTED_VALUE;
export const CIRCULAR_VALUE = '[Circular]';

/** Keys whose values are never suitable for a structured log. */
const SENSITIVE_KEY = /(?:^|[_-])(authorization|proxyauthorization|auth|authheader|cookie|setcookie|bearer|token|accesstoken|refreshtoken|idtoken|secret|password|credential|credentials|apikey|privatekey|clientsecret|prompt|raw|rawmessage|sdkmessage|sdkraw|transcript)(?:$|[_-])/iu;

/**
 * Redact credentials that accidentally occur in a free-form diagnostic string
 * (for example an Error message or a URL copied into a field).  Structured
 * key-based redaction below remains the primary boundary.
 */
function redactString(value: string): string {
  let result = value.replace(
    /((?:authorization|proxy-authorization|cookie|set-cookie|bearer)\s*[:=]\s*)(Bearer\s+)?[^\s,;"']+/giu,
    (_match, prefix: string, scheme: string | undefined) => `${prefix}${scheme === undefined ? '' : 'Bearer '}${REDACTED_VALUE}`,
  );
  result = result.replace(
    /\bBearer\s+[^\s,;"']+/giu,
    `Bearer ${REDACTED_VALUE}`,
  );
  result = result.replace(
    /([?&](?:token|access_token|refresh_token|id_token|authorization|api_key|apikey|secret|password)\s*=)[^&#\s]*/giu,
    `$1${REDACTED_VALUE}`,
  );
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]+/gu, '').toLowerCase();
  return SENSITIVE_KEY.test(key) || /(?:authorization|proxyauthorization|authheader|cookie|setcookie|bearer|token|accesstoken|refreshtoken|idtoken|secret|password|credential|credentials|apikey|privatekey|clientsecret|prompt|raw|rawmessage|sdkmessage|sdkraw|transcript)/u.test(normalized);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
  }
  if (value instanceof Error) {
    const error: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack !== undefined) {
      error.stack = redactString(value.stack);
    }
    return redactObject(error, seen);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  return redactObject(value as Record<string, unknown>, seen);
}

function redactObject(value: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    try {
      result[key] = redactValue(value[key], seen);
    } catch {
      // A hostile getter must not prevent a safe log event from being emitted.
      result[key] = REDACTED_VALUE;
    }
  }
  return result;
}

/** Pure, non-mutating recursive redaction for JSON-shaped structured logs. */
export function redactStructuredLog<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

export const redactLog = redactStructuredLog;
export const redact = redactStructuredLog;
