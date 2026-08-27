import { describe, expect, it } from 'vitest';

import { createChatUri } from '../../src/domain/resources.js';
import {
  authorizeResource,
  createAccessControlList,
  createResourceAcl,
  isAllowed,
  reduceAcl,
  type AccessControlList,
} from '../../src/security/acl.js';
import { createPrincipal } from '../../src/security/identity.js';

const chat = createChatUri('session-1', 'chat-1');
const otherChat = createChatUri('session-1', 'chat-2');

function aclFor(resource = chat): AccessControlList {
  return createAccessControlList([{
    resource,
    tenantId: 'tenant-a',
    grants: [{
      principalId: 'alice',
      capabilities: ['read', 'subscribe', 'send'],
    }],
  }]);
}

describe('resource ACL policy', () => {
  it('allows same-tenant principals only for explicitly granted capabilities', () => {
    const alice = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['read', 'send'] });
    expect(authorizeResource(alice, 'read', chat, aclFor())).toEqual({ kind: 'allow' });
    expect(authorizeResource(alice, 'send', chat, aclFor())).toEqual({ kind: 'allow' });
    expect(authorizeResource(alice, 'approve', chat, aclFor())).toEqual({
      kind: 'deny',
      reason: 'capability_not_granted',
    });
  });

  it('requires the independent approve capability for approval and input resolution', () => {
    const readOnly = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['read', 'subscribe'] });
    const approver = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['approve'] });
    const policy = createResourceAcl({
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'alice', capabilities: ['read', 'subscribe', 'approve'] }],
    });
    expect(authorizeResource(readOnly, 'resolveApproval', chat, policy)).toEqual({
      kind: 'deny',
      reason: 'capability_not_granted',
    });
    expect(authorizeResource(approver, 'resolveInput', chat, policy)).toEqual({ kind: 'allow' });
  });

  it('denies cross-tenant access even when the principal id and SDK-like id match', () => {
    const principal = createPrincipal({
      principalId: 'same-sdk-session-id',
      tenantId: 'tenant-b',
      capabilities: ['read', 'send', 'approve'],
    });
    const result = authorizeResource(principal, 'read', chat, createResourceAcl({
      resource: chat,
      tenantId: 'tenant-a',
      grants: [{ principalId: 'same-sdk-session-id', capabilities: ['read', 'send', 'approve'] }],
    }));
    expect(result).toEqual({ kind: 'deny', reason: 'cross_tenant' });
    expect(JSON.stringify(result)).not.toContain('same-sdk-session-id');
  });

  it('denies unknown resources without consulting or exposing provider/session ids', () => {
    const principal = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['admin'] });
    const result = authorizeResource(principal, 'read', otherChat, aclFor());
    expect(result).toEqual({ kind: 'deny', reason: 'resource_not_found' });
  });

  it('supports tenant-wide grants but never lets a grant change a resource tenant', () => {
    const principal = createPrincipal({ principalId: 'bob', tenantId: 'tenant-a', capabilities: ['read'] });
    const policy = createResourceAcl({ resource: chat, tenantId: 'tenant-a', capabilities: ['read'] });
    expect(authorizeResource(principal, 'read', chat, policy)).toEqual({ kind: 'allow' });
    const changed = reduceAcl(createAccessControlList([policy]), {
      type: 'grant', resource: chat, tenantId: 'tenant-b', capabilities: ['read'],
    });
    expect(changed).toEqual(createAccessControlList([policy]));
  });

  it('reduces grant and revoke actions immutably and deterministically', () => {
    const empty = createAccessControlList([{
      resource: chat,
      tenantId: 'tenant-a',
      grants: [],
    }]);
    const granted = reduceAcl(empty, {
      type: 'grant', resource: chat, tenantId: 'tenant-a', principalId: 'alice', capabilities: ['read', 'approve'],
    });
    expect(empty.resources[0]?.grants).toBeUndefined();
    const alice = createPrincipal({ principalId: 'alice', tenantId: 'tenant-a', capabilities: ['read', 'approve'] });
    expect(isAllowed(authorizeResource(alice, 'approve', chat, granted))).toBe(true);
    const revoked = reduceAcl(granted, {
      type: 'revoke', resource: chat, tenantId: 'tenant-a', principalId: 'alice', capabilities: ['approve'],
    });
    expect(authorizeResource(alice, 'read', chat, revoked)).toEqual({ kind: 'allow' });
    expect(authorizeResource(alice, 'approve', chat, revoked)).toEqual({
      kind: 'deny', reason: 'capability_not_granted',
    });
    expect(reduceAcl(granted, {
      type: 'removeResource', resource: otherChat,
    })).toEqual(granted);
  });
});
