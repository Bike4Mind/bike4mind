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
    // Deliberately NOT the membership set: the two are independent, and a fake that returned the
    // same ids for both would pass even if the context carried the wrong one.
    resolveAdministeredOrgIds: vi.fn().mockResolvedValue(['org-b']),
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

/**
 * `administeredOrgIds` is the input to canManageLake's two org rungs (an admin of the lake's own
 * org, and an owner/curator ORG grant for an org the actor administers). `ManageActor` defaults it
 * to `[]` for callers that have not threaded it, so an unset field kills both rungs with no error
 * and no log line - which is exactly how it went unnoticed on this surface. These tests are the
 * guard against it going quiet again.
 */
describe('buildSlackAccessContext org-admin resolution', () => {
  const actor = (isAdmin: boolean): SlackIngestActor => ({ id: 'u1', isAdmin, tags: [] });

  const deps = () => ({
    resolveEntitlementKeys: vi.fn().mockResolvedValue(['product:pro']),
    resolveMembershipOrgIds: vi.fn().mockResolvedValue(['org-a']),
    resolveAdministeredOrgIds: vi.fn().mockResolvedValue(['org-b']),
  });

  it('populates the set for a non-admin, keeping it distinct from membership', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(false), d);

    expect(d.resolveAdministeredOrgIds).toHaveBeenCalledWith('u1');
    // Must land in the context, not merely be fetched: canManageLake reads it off the context.
    expect(ctx.administeredOrgIds).toEqual(['org-b']);
    expect(ctx.organizationIds).toEqual(['org-a']);
  });

  it('zeroes it for a platform admin, who is granted on the rung above it', async () => {
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(true), d);

    expect(d.resolveAdministeredOrgIds).not.toHaveBeenCalled();
    expect(ctx.administeredOrgIds).toEqual([]);
  });

  it('zeroes it for an admin even when the entitlement opt-in is set', async () => {
    // The two are independent: `list` opts an admin into entitlement resolution because those keys
    // gate the findAccessible ROW SET, while these ids only feed a per-row manage label that
    // handleList's own `isWritable` restores. Coupling them would resolve the set for nothing.
    const d = deps();

    const ctx = await buildSlackAccessContext(actor(true), d, { resolveEntitlementsForAdmin: true });

    expect(d.resolveAdministeredOrgIds).not.toHaveBeenCalled();
    expect(ctx.administeredOrgIds).toEqual([]);
    // The opt-in demonstrably FIRED on the same call, so this pins independence rather than two
    // fields that happen to be empty together.
    expect(ctx.entitlementKeys).toEqual(['product:pro']);
  });
});
