import { describe, expect, it, vi } from 'vitest';

import { buildSlackAccessContext, type SlackIngestActor } from './dataLakeIngestAuthz';

/**
 * Covers `buildSlackAccessContext`'s entitlement-resolution rule directly. The handler tests mock
 * this module, so they can only assert the call site passes the opt-in; the ingest tests exercise
 * the two DEFAULT paths. Neither reaches the opt-in branch itself, which is the branch `list`
 * depends on - an admin evaluated through the non-admin arms needs real keys or an entitlement-gated
 * lake drops out of a reply `add` still accepts.
 */
describe('buildSlackAccessContext entitlement resolution', () => {
  const actor = (isAdmin: boolean): SlackIngestActor => ({
    id: 'u1',
    isAdmin,
    tags: ['beta'],
    email: 'u1@example.com',
    emailVerified: true,
  });

  const deps = () => ({
    resolveEntitlementKeys: vi.fn().mockResolvedValue(['product:pro']),
    resolveMembershipOrgIds: vi.fn().mockResolvedValue(['org-a']),
  });

  it('resolves keys for a non-admin, opt-in or not', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(false), d);

    expect(d.resolveEntitlementKeys).toHaveBeenCalledWith(actor(false));
    expect(ctx.entitlementKeys).toEqual(['product:pro']);
    expect(ctx.organizationIds).toEqual(['org-a']);
  });

  it('skips resolution for an admin by default, since the write gates never read the keys', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(true), d);

    expect(d.resolveEntitlementKeys).not.toHaveBeenCalled();
    expect(ctx.entitlementKeys).toEqual([]);
    expect(ctx.isAdmin).toBe(true);
  });

  it('resolves keys for an admin when the caller opts in', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(true), d, { resolveEntitlementsForAdmin: true });

    expect(d.resolveEntitlementKeys).toHaveBeenCalledWith(actor(true));
    // The keys must land in the context, not merely be fetched: the list query reads them through
    // findAccessible's requirement constraint.
    expect(ctx.entitlementKeys).toEqual(['product:pro']);
    expect(ctx.isAdmin).toBe(true);
  });

  it('treats an explicit false like the default', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(true), d, { resolveEntitlementsForAdmin: false });

    expect(d.resolveEntitlementKeys).not.toHaveBeenCalled();
    expect(ctx.entitlementKeys).toEqual([]);
  });
});
