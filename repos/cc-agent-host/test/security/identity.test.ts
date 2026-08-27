import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  createBearerToken,
  createCapability,
  createPrincipal,
  createPrincipalId,
  createTenantId,
  hasCapability,
  type PrincipalId,
  type TenantId,
} from '../../src/security/identity.js';

describe('security identities', () => {
  it('keeps principal and tenant brands distinct at compile time', () => {
    const principal: PrincipalId = createPrincipalId('user-1');
    const tenant: TenantId = createTenantId('tenant-1');
    expect(principal).toBe('user-1');
    expect(tenant).toBe('tenant-1');
    // @ts-expect-error A tenant identity cannot be assigned as a principal id.
    const invalidPrincipal: PrincipalId = tenant;
    // @ts-expect-error A principal identity cannot be assigned as a tenant id.
    const invalidTenant: TenantId = principal;
    expect(invalidPrincipal).toBe(tenant);
    expect(invalidTenant).toBe(principal);
  });

  it.each(['', '.', '..', 'has space', 'a/b', 'a?b', 'a#b', 'a\\b'])('rejects unsafe identity %s', (value) => {
    expect(() => createPrincipalId(value)).toThrow();
    expect(() => createTenantId(value)).toThrow();
    expect(() => createCapability(value)).toThrow();
  });

  it('creates a frozen deduplicated principal snapshot and supports admin capability', () => {
    const value = createPrincipal({
      principalId: 'user-1',
      tenantId: 'tenant-1',
      capabilities: ['read', 'read', 'admin'],
    });
    expect(value).toEqual({
      principalId: 'user-1',
      tenantId: 'tenant-1',
      capabilities: [CAPABILITIES.read, CAPABILITIES.admin],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.capabilities)).toBe(true);
    expect(hasCapability(value, 'read')).toBe(true);
    expect(hasCapability(value, 'approve')).toBe(true);
  });

  it('does not expose bearer values through principal or invalid identity errors', () => {
    const token = createBearerToken('secret-token-value');
    expect(token).toBe('secret-token-value');
    expect(() => createBearerToken('bad token')).toThrowError(/bearer token/iu);
  });
});
