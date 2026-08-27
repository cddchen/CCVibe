import { describe, expect, it } from 'vitest';

import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  redactStructuredLog,
} from '../../src/security/redaction.js';

describe('structured log redaction', () => {
  it('recursively redacts credentials, cookies, prompts, and SDK raw messages', () => {
    const source = {
      request: {
        authorization: 'Bearer top-secret-token',
        cookie: 'sid=secret-cookie',
        headers: { 'x-api-key': 'secret-api-key', authorizationHeader: 'Bearer another-secret' },
      },
      prompt: 'do not persist this prompt',
      sdkRawMessage: { content: 'raw transcript secret' },
      nested: [{ password: 'secret-password' }, { value: 'safe' }],
      message: 'Bearer free-form-secret https://example.test/?token=query-secret',
    };
    const result = redactStructuredLog(source);
    expect(result).toEqual({
      request: {
        authorization: REDACTED_VALUE,
        cookie: REDACTED_VALUE,
        headers: { 'x-api-key': REDACTED_VALUE, authorizationHeader: REDACTED_VALUE },
      },
      prompt: REDACTED_VALUE,
      sdkRawMessage: REDACTED_VALUE,
      nested: [{ password: REDACTED_VALUE }, { value: 'safe' }],
      message: `Bearer ${REDACTED_VALUE} https://example.test/?token=${REDACTED_VALUE}`,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(source.prompt).toBe('do not persist this prompt');
  });

  it('redacts free-form credential-like values and preserves safe diagnostics', () => {
    expect(redactStructuredLog({ value: 'Authorization: Bearer abc123' })).toEqual({
      value: `Authorization: Bearer ${REDACTED_VALUE}`,
    });
    expect(redactStructuredLog({ value: 'https://example.test/path?access_token=abc123&ok=yes' })).toEqual({
      value: `https://example.test/path?access_token=${REDACTED_VALUE}&ok=yes`,
    });
    expect(redactStructuredLog({ code: 'E_TIMEOUT', attempt: 2, ok: false })).toEqual({
      code: 'E_TIMEOUT', attempt: 2, ok: false,
    });
  });

  it('handles cycles without mutating the source graph', () => {
    const source: { name: string; self?: unknown } = { name: 'safe' };
    source.self = source;
    const result = redactStructuredLog(source) as { name: string; self: unknown };
    expect(result).toEqual({ name: 'safe', self: CIRCULAR_VALUE });
    expect(source.self).toBe(source);
  });

  it('does not leak secret-bearing Error messages or stacks', () => {
    const secret = 'error-bearer-secret';
    const error = new Error(`Bearer ${secret}`);
    const result = redactStructuredLog({ error });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((result as { error: { message: string } }).error.message).toContain(REDACTED_VALUE);
  });
});

