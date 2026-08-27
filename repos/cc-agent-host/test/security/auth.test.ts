import { describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATION_FAILURE,
  authenticateBearer,
  extractBearer,
  extractBearerToken,
  type AuthorizationInput,
} from '../../src/security/auth.js';
import { createPrincipal } from '../../src/security/identity.js';

describe('security bearer authentication', () => {
  it.each<AuthorizationInput | string | undefined>([
    undefined,
    '',
    'Basic abc',
    'Bearer',
    'Bearer  ',
    'Bearer one two',
    ['Bearer one', 'Bearer two'] as unknown as AuthorizationInput,
  ])('returns the same constant-shape failure for malformed input %s', (value) => {
    expect(extractBearer(value)).toEqual({ ok: false });
  });

  it('extracts one bearer value from a header object and never from query-shaped input', () => {
    expect(extractBearer({ authorization: 'Bearer secret-token' })).toEqual({
      ok: true,
      token: 'secret-token',
    });
    expect(extractBearerToken('Bearer secret-token')).toBe('secret-token');
    expect(extractBearer({ authorization: ['Bearer secret-token'] })).toEqual({ ok: true, token: 'secret-token' });
    expect(extractBearer({ authorization: ['Bearer one', 'Bearer two'] })).toEqual({ ok: false });
    expect(extractBearer('/ws?token=secret-token')).toEqual({ ok: false });
  });

  it('calls the injected verifier only after extraction and collapses all failures', async () => {
    const principal = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['read'] });
    const verify = vi.fn(async (token: string) => token === 'good' ? principal : null);
    expect(await authenticateBearer('Bearer good', verify)).toEqual({ ok: true, principal });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await authenticateBearer('Basic good', verify)).toBe(AUTHENTICATION_FAILURE);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await authenticateBearer('Bearer bad', verify)).toBe(AUTHENTICATION_FAILURE);
  });

  it('collapses a throwing verifier and never returns the bearer value in an error', async () => {
    const secret = 'very-secret-bearer-value';
    const result = await authenticateBearer(`Bearer ${secret}`, () => {
      throw new Error(secret);
    });
    expect(result).toBe(AUTHENTICATION_FAILURE);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.keys(result)).toEqual(['ok', 'error']);
  });
});

