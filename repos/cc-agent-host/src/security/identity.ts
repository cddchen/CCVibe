import { MAX_OPAQUE_ID_BYTES, type Brand } from '../domain/ids.js';

/**
 * Security identities deliberately use brands that are different from the
 * domain's client, connection and provider/session identifiers.  A value can
 * have the same bytes at runtime, but it cannot accidentally cross a typed
 * authorization boundary.
 */
export type PrincipalId = Brand<string, 'PrincipalId'>;
export type TenantId = Brand<string, 'TenantId'>;
export type Capability = Brand<string, 'Capability'>;
/** More descriptive alias for code that calls capabilities permissions. */
export type CapabilityId = Capability;
/** A token is only ever handed to the injected verifier. */
export type BearerToken = Brand<string, 'BearerToken'>;

const OPAQUE_ID = /^[^\s/?#\\]+$/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateOpaque(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${label} must be a non-empty opaque identifier`);
  }
  if (utf8ByteLength(value) > MAX_OPAQUE_ID_BYTES) {
    throw new RangeError(`${label} exceeds the maximum identifier length`);
  }
}

function brand<Name extends string>(value: string): Brand<string, Name> {
  return value as Brand<string, Name>;
}

export function createPrincipalId(value: string): PrincipalId {
  validateOpaque(value, 'principalId');
  return brand<'PrincipalId'>(value);
}

export const parsePrincipalId = createPrincipalId;
export const principalId = createPrincipalId;

export function createTenantId(value: string): TenantId {
  validateOpaque(value, 'tenantId');
  return brand<'TenantId'>(value);
}

export const parseTenantId = createTenantId;
export const tenantId = createTenantId;

export function createCapability(value: string): Capability {
  validateOpaque(value, 'capability');
  return brand<'Capability'>(value);
}

export const parseCapability = createCapability;
export const capability = createCapability;
export const createCapabilityId = createCapability;
export const parseCapabilityId = parseCapability;

export function createBearerToken(value: string): BearerToken {
  // Unlike an ID, a bearer credential is not a URI segment: valid opaque
  // tickets may contain `/`, `?`, or `#`.  They are accepted here only long
  // enough to hand to the verifier; this module never places them in a URL.
  if (typeof value !== 'string' || value.length === 0 || /\s/iu.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('bearer token must be a non-empty opaque credential');
  }
  if (utf8ByteLength(value) > MAX_OPAQUE_ID_BYTES * 32) {
    throw new RangeError('bearer token exceeds the maximum credential length');
  }
  return brand<'BearerToken'>(value);
}

/** Capabilities understood by the first security policy implementation. */
export const SECURITY_CAPABILITIES = Object.freeze({
  read: createCapability('read'),
  subscribe: createCapability('subscribe'),
  send: createCapability('send'),
  configure: createCapability('configure'),
  interrupt: createCapability('interrupt'),
  approve: createCapability('approve'),
  delete: createCapability('delete'),
  admin: createCapability('admin'),
});

/** Short alias used by policy callers. */
export const CAPABILITIES = SECURITY_CAPABILITIES;
export type BuiltInCapability = (typeof SECURITY_CAPABILITIES)[keyof typeof SECURITY_CAPABILITIES];

export interface Principal {
  readonly principalId: PrincipalId;
  readonly tenantId: TenantId;
  /** Capabilities supplied by the authenticated identity provider. */
  readonly capabilities: readonly Capability[];
}

export interface PrincipalInput {
  readonly principalId: PrincipalId | string;
  readonly tenantId: TenantId | string;
  readonly capabilities?: readonly (Capability | string)[];
}

/**
 * Create a frozen principal snapshot.  It is intentionally a value object:
 * authorization never consults process state, an SDK session id, or a mutable
 * client registry.
 */
export function createPrincipal(input: PrincipalInput): Principal {
  const principalIdValue = typeof input.principalId === 'string'
    ? createPrincipalId(input.principalId)
    : input.principalId;
  const tenantIdValue = typeof input.tenantId === 'string'
    ? createTenantId(input.tenantId)
    : input.tenantId;
  // Re-validate branded values at runtime as this function is also a boundary
  // for JSON-decoded identity-provider output.
  createPrincipalId(principalIdValue);
  createTenantId(tenantIdValue);

  const capabilities: Capability[] = [];
  for (const value of input.capabilities ?? []) {
    const normalized = typeof value === 'string' ? createCapability(value) : value;
    createCapability(normalized);
    if (!capabilities.includes(normalized)) {
      capabilities.push(normalized);
    }
  }

  return Object.freeze({
    principalId: principalIdValue,
    tenantId: tenantIdValue,
    capabilities: Object.freeze(capabilities),
  });
}

export const principal = createPrincipal;

export function hasCapability(principalValue: Principal, required: Capability | string): boolean {
  const capabilityValue = typeof required === 'string' ? createCapability(required) : required;
  return principalValue.capabilities.includes(capabilityValue)
    || principalValue.capabilities.includes(SECURITY_CAPABILITIES.admin);
}
