import { describe, it, expect, vi } from 'vitest';
import { buildToolAccessContext } from './toolAccessContext';
import type { ToolContext } from '../base/types';

function makeContext(user: Record<string, unknown>, entitlementKeys?: string[], apiKeyId?: string) {
  const organizations = {
    findMembershipOrgIds: vi.fn().mockResolvedValue(['org1', 'org2']),
    findIdsWithAdminRights: vi.fn().mockResolvedValue(['org1']),
  };
  const context = {
    userId: 'u1',
    user: { id: 'u1', ...user },
    entitlementKeys,
    apiKeyId,
    db: { organizations },
  } as unknown as Pick<ToolContext, 'userId' | 'user' | 'entitlementKeys' | 'db' | 'apiKeyId'>;
  return { context, organizations };
}

describe('buildToolAccessContext', () => {
  it('reads membership and administered orgs from the org ACL for a regular user', async () => {
    const { context, organizations } = makeContext({ tags: ['t1'], organizationId: 'stale-org' }, ['ent1']);

    await expect(buildToolAccessContext(context)).resolves.toEqual({
      userId: 'u1',
      isAdmin: false,
      userTags: ['t1'],
      organizationIds: ['org1', 'org2'],
      entitlementKeys: ['ent1'],
      administeredOrgIds: ['org1'],
    });
    expect(organizations.findMembershipOrgIds).toHaveBeenCalledWith('u1');
    expect(organizations.findIdsWithAdminRights).toHaveBeenCalledWith('u1');
  });

  it('gives a platform admin no entitlement keys or administered orgs', async () => {
    const { context, organizations } = makeContext({ isAdmin: true }, ['ent1']);

    const ctx = await buildToolAccessContext(context);

    expect(ctx).toMatchObject({ isAdmin: true, userTags: [], entitlementKeys: [], administeredOrgIds: [] });
    expect(organizations.findIdsWithAdminRights).not.toHaveBeenCalled();
  });

  it('defaults missing tags and entitlements to empty lists', async () => {
    const { context } = makeContext({});

    const ctx = await buildToolAccessContext(context);

    expect(ctx.userTags).toEqual([]);
    expect(ctx.entitlementKeys).toEqual([]);
  });

  it('attributes a key-driven turn to the key, with the owner as on-behalf-of', async () => {
    const { context } = makeContext({}, undefined, 'key1');

    const ctx = await buildToolAccessContext(context);

    expect(ctx.userId).toBe('u1');
    expect(ctx.auditPrincipal).toEqual({ principalKind: 'apiKey', principalId: 'key1', onBehalfOfUserId: 'u1' });
  });
});
