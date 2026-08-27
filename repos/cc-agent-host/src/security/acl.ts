import type { AgentResource } from '../domain/resources.js';
import {
  CAPABILITIES,
  createCapability,
  createPrincipalId,
  createTenantId,
  type Capability,
  type Principal,
  type PrincipalId,
  type TenantId,
} from './identity.js';

/** Operations are deliberately independent of SDK/provider session ids. */
export type ResourceAction =
  | 'read'
  | 'subscribe'
  | 'send'
  | 'configure'
  | 'interrupt'
  | 'approve'
  | 'input'
  | 'resolveApproval'
  | 'resolveInput'
  | 'delete';

export type AuthorizationAction = ResourceAction | Capability;

export const RESOURCE_ACTIONS = Object.freeze({
  read: CAPABILITIES.read,
  subscribe: CAPABILITIES.subscribe,
  send: CAPABILITIES.send,
  configure: CAPABILITIES.configure,
  interrupt: CAPABILITIES.interrupt,
  approve: CAPABILITIES.approve,
  // Input resolution is intentionally mapped to the same explicit approval
  // capability. Read/subscribe alone can never settle a pending input.
  input: CAPABILITIES.approve,
  resolveApproval: CAPABILITIES.approve,
  resolveInput: CAPABILITIES.approve,
  delete: CAPABILITIES.delete,
});

export interface AclGrant {
  /** Omitted means the resource tenant; an explicit value is checked too. */
  readonly tenantId?: TenantId;
  /** Omitted means every principal in the grant tenant. */
  readonly principalId?: PrincipalId;
  readonly capabilities: readonly Capability[];
}

export interface ResourceAcl {
  readonly resource: AgentResource;
  readonly tenantId: TenantId;
  /** Optional tenant-wide grants for this resource. */
  readonly capabilities?: readonly Capability[];
  readonly grants?: readonly AclGrant[];
}

export interface ResourceAclInput {
  readonly resource: AgentResource;
  readonly tenantId: TenantId | string;
  readonly capabilities?: readonly (Capability | string)[];
  readonly grants?: readonly {
    readonly tenantId?: TenantId | string;
    readonly principalId?: PrincipalId | string;
    readonly capabilities: readonly (Capability | string)[];
  }[];
}

/** A value ACL is convenient for pure tests and does not own mutable maps. */
export interface AccessControlList {
  readonly resources: readonly ResourceAcl[];
}

export type Acl = AccessControlList;

export function createResourceAcl(input: ResourceAclInput): ResourceAcl {
  const capabilities = normalizeCapabilities(input.capabilities);
  const grants = (input.grants ?? []).map((grant): AclGrant => ({
    ...(grant.tenantId === undefined ? {} : { tenantId: normalizeTenant(grant.tenantId) }),
    ...(grant.principalId === undefined ? {} : { principalId: normalizePrincipal(grant.principalId) }),
    capabilities: normalizeCapabilities(grant.capabilities),
  }));
  return Object.freeze({
    resource: input.resource,
    tenantId: normalizeTenant(input.tenantId),
    ...(capabilities.length === 0 ? {} : { capabilities }),
    ...(grants.length === 0 ? {} : { grants: Object.freeze(grants) }),
  });
}

export function createAccessControlList(resources: readonly ResourceAclInput[]): AccessControlList {
  const normalized = resources.map(createResourceAcl);
  return Object.freeze({ resources: Object.freeze(normalized) });
}

export const createAcl = createAccessControlList;

export type AuthorizationDenyReason =
  | 'resource_not_found'
  | 'cross_tenant'
  | 'principal_not_granted'
  | 'capability_not_granted'
  | 'invalid_policy';

export interface Allow {
  readonly kind: 'allow';
}

export interface Deny {
  readonly kind: 'deny';
  readonly reason: AuthorizationDenyReason;
}

export type AuthorizationResult = Allow | Deny;

const ALLOW: Allow = Object.freeze({ kind: 'allow' });

function normalizeTenant(value: TenantId | string): TenantId {
  return typeof value === 'string' ? createTenantId(value) : value;
}

function normalizePrincipal(value: PrincipalId | string): PrincipalId {
  return typeof value === 'string' ? createPrincipalId(value) : value;
}

function normalizeCapabilities(values: readonly (Capability | string)[] | undefined): readonly Capability[] {
  const normalized: Capability[] = [];
  for (const value of values ?? []) {
    const capability = typeof value === 'string' ? createCapability(value) : value;
    if (!normalized.includes(capability)) {
      normalized.push(capability);
    }
  }
  return Object.freeze(normalized);
}

function actionCapability(action: AuthorizationAction): Capability {
  if (typeof action !== 'string') {
    return action;
  }
  const mapped = RESOURCE_ACTIONS[action as ResourceAction];
  if (mapped !== undefined) {
    return mapped;
  }
  return createCapability(action);
}

function hasCapability(capabilities: readonly Capability[] | undefined, required: Capability): boolean {
  return capabilities?.includes(required) === true || capabilities?.includes(CAPABILITIES.admin) === true;
}

function asPolicies(acl: AccessControlList | ResourceAcl): readonly ResourceAcl[] {
  return 'resources' in acl ? acl.resources : [acl];
}

function deny(reason: AuthorizationDenyReason): Deny {
  return Object.freeze({ kind: 'deny', reason });
}

/**
 * Pure resource authorization.  Both identity capabilities and resource ACL
 * grants must contain the requested capability.  Tenant equality is checked
 * before principal grants, so a matching principal/SDK id can never cross a
 * tenant boundary.
 */
export function authorizeResource(
  principal: Principal,
  action: AuthorizationAction,
  resource: AgentResource,
  acl: AccessControlList | ResourceAcl,
): AuthorizationResult {
  try {
    const policy = asPolicies(acl).find((candidate) => candidate.resource === resource);
    if (policy === undefined) {
      return deny('resource_not_found');
    }
    if (principal.tenantId !== policy.tenantId) {
      return deny('cross_tenant');
    }

    const required = actionCapability(action);
    if (!hasCapability(principal.capabilities, required)) {
      return deny('capability_not_granted');
    }

    const tenantCapabilities = policy.capabilities;
    if (hasCapability(tenantCapabilities, required)) {
      return ALLOW;
    }

    const grants = policy.grants ?? [];
    const applicable = grants.filter((grant) => (
      (grant.tenantId === undefined || grant.tenantId === principal.tenantId)
      && (grant.principalId === undefined || grant.principalId === principal.principalId)
    ));
    if (applicable.length === 0) {
      return deny('principal_not_granted');
    }
    if (applicable.some((grant) => hasCapability(grant.capabilities, required))) {
      return ALLOW;
    }
    return deny('capability_not_granted');
  } catch {
    return deny('invalid_policy');
  }
}

/** Short alias for orchestration code. */
export const authorize = authorizeResource;

/**
 * Pure ACL mutation vocabulary.  A reducer is used instead of a mutable ACL
 * registry so policy updates can be replayed, tested, and audited as values.
 * A grant without a principal is tenant-wide; a grant with a principal is
 * exact-principal only.  `replace` and `removeResource` are useful for
 * durable-policy hydration and administrative revocation respectively.
 */
export type AclAction =
  | {
      readonly type: 'grant';
      readonly resource: AgentResource;
      readonly tenantId: TenantId | string;
      readonly principalId?: PrincipalId | string;
      readonly capabilities: readonly (Capability | string)[];
    }
  | {
      readonly type: 'revoke';
      readonly resource: AgentResource;
      readonly tenantId?: TenantId | string;
      readonly principalId?: PrincipalId | string;
      readonly capabilities?: readonly (Capability | string)[];
    }
  | {
      readonly type: 'replace';
      readonly policy: ResourceAclInput;
    }
  | {
      readonly type: 'removeResource';
      readonly resource: AgentResource;
    };

export function reduceAcl(acl: AccessControlList, action: AclAction): AccessControlList {
  const policies = [...acl.resources];
  if (action.type === 'removeResource') {
    return createAccessControlList(policies.filter((policy) => policy.resource !== action.resource));
  }
  if (action.type === 'replace') {
    const replacement = createResourceAcl(action.policy);
    const index = policies.findIndex((policy) => policy.resource === replacement.resource);
    if (index < 0) {
      return createAccessControlList([...policies, replacement]);
    }
    policies[index] = replacement;
    return createAccessControlList(policies);
  }

  const index = policies.findIndex((policy) => policy.resource === action.resource);
  const current = index < 0
    ? action.type === 'grant'
      ? createResourceAcl({ resource: action.resource, tenantId: action.tenantId, capabilities: [] })
      : undefined
    : policies[index];
  if (current === undefined) {
    return acl;
  }
  if (action.type === 'grant') {
    if (current.tenantId !== normalizeTenant(action.tenantId)) {
      // A resource cannot be retargeted by a grant.  Callers must replace the
      // complete policy explicitly, avoiding an accidental cross-tenant union.
      return acl;
    }
    const capabilities = normalizeCapabilities(action.capabilities);
    const grant: AclGrant = {
      ...(action.tenantId === undefined ? {} : { tenantId: normalizeTenant(action.tenantId) }),
      ...(action.principalId === undefined ? {} : { principalId: normalizePrincipal(action.principalId) }),
      capabilities,
    };
    const existingGrants = current.grants ?? [];
    const sameScope = (candidate: AclGrant): boolean => (
      candidate.tenantId === grant.tenantId && candidate.principalId === grant.principalId
    );
    const grantIndex = existingGrants.findIndex(sameScope);
    const nextGrants = [...existingGrants];
    if (grantIndex < 0) {
      nextGrants.push(grant);
    } else {
      const previous = nextGrants[grantIndex];
      if (previous === undefined) {
        return acl;
      }
      nextGrants[grantIndex] = {
        ...previous,
        capabilities: normalizeCapabilities([...previous.capabilities, ...capabilities]),
      };
    }
  const next = createResourceAcl({
    resource: current.resource,
    tenantId: current.tenantId,
    ...(current.capabilities === undefined ? {} : { capabilities: current.capabilities }),
    grants: nextGrants,
  });
    if (index < 0) {
      return createAccessControlList([...policies, next]);
    }
    policies[index] = next;
    return createAccessControlList(policies);
  }

  const targetTenant = action.tenantId === undefined ? undefined : normalizeTenant(action.tenantId);
  const targetPrincipal = action.principalId === undefined ? undefined : normalizePrincipal(action.principalId);
  const targetCapabilities = action.capabilities === undefined
    ? undefined
    : new Set(normalizeCapabilities(action.capabilities));
  const matchingScope = (grant: AclGrant): boolean => (
    (targetTenant === undefined || grant.tenantId === targetTenant)
    && (targetPrincipal === undefined || grant.principalId === targetPrincipal)
  );
  const nextGrants = (current.grants ?? []).flatMap((grant) => {
    if (!matchingScope(grant)) {
      return [grant];
    }
    if (targetCapabilities === undefined) {
      return [];
    }
    const capabilities = grant.capabilities.filter((capability) => !targetCapabilities.has(capability));
    return capabilities.length === 0 ? [] : [{ ...grant, capabilities }];
  });
  const next = createResourceAcl({
    resource: current.resource,
    tenantId: current.tenantId,
    ...(targetPrincipal === undefined && targetTenant === undefined && targetCapabilities !== undefined
      ? { capabilities: (current.capabilities ?? []).filter((capability) => !targetCapabilities.has(capability)) }
      : current.capabilities === undefined ? {} : { capabilities: current.capabilities }),
    grants: nextGrants,
  });
  if (index < 0) {
    return acl;
  }
  policies[index] = next;
  return createAccessControlList(policies);
}

export const aclReducer = reduceAcl;
export const applyAclAction = reduceAcl;

export function isAllowed(result: AuthorizationResult): result is Allow {
  return result.kind === 'allow';
}

export function isDenied(result: AuthorizationResult): result is Deny {
  return result.kind === 'deny';
}
