export const REDACTED_VALUE = '[REDACTED]' as const;

const SENSITIVE_KEY = /^(?:authorization|auth|bearer|bearerToken|token|accessToken|refreshToken|password|secret|apiKey)$/iu;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => redactSecrets(item)));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED_VALUE : redactSecrets(child);
    }
    return Object.freeze(result);
  }
  return value;
}

export function serializeRedacted(value: unknown): string {
  const redacted = redactSecrets(value);
  try {
    return JSON.stringify(redacted) ?? 'null';
  } catch {
    return REDACTED_VALUE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
