import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { classifyLakeAccess } from './classifyLakeAccess';
import {
  resolveReadGrant,
  resolveLakeReadAccess,
  resolveEnforceReadGrants,
  ENFORCE_LAKE_READ_GRANTS_KEY,
  READ_GRANT_ENFORCEMENT_READY,
} from './resolveLakeReadAccess';
import type { LakeGrant } from './manageRule';

type LakeShape = Pick<
  IDataLakeDocument,
  'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
>;

const lake = (over: Partial<LakeShape> = {}): LakeShape => ({
  createdByUserId: 'creator',
  organizationId: undefined,
  requiredUserTag: undefined,
  requiredEntitlement: undefined,
  isPublic: false,
  ...over,
});

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'stranger',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...over,
});

const grant = (
  role: LakeGrant['role'],
  principalId = 'stranger',
  principalType: LakeGrant['principalType'] = 'user'
): LakeGrant => ({
  principalType,
  principalId,
  role,
});

describe('classifyLakeAccess - the five arms the cutover diffs against', () => {
  it('owner-admin: platform admin bypass', () => {
    expect(classifyLakeAccess(lake(), ctx({ isAdmin: true }))).toEqual({ allowed: true, arm: 'owner-admin' });
  });

  it('owner-admin: the creator', () => {
    expect(classifyLakeAccess(lake(), ctx({ userId: 'creator' }))).toEqual({ allowed: true, arm: 'owner-admin' });
  });

  it('public: gate-less public lake admits everyone', () => {
    expect(classifyLakeAccess(lake({ isPublic: true }), ctx())).toEqual({ allowed: true, arm: 'public' });
  });

  it('public: a gate added post-publish still holds (defense in depth)', () => {
    expect(classifyLakeAccess(lake({ isPublic: true, requiredUserTag: 'vip' }), ctx())).toEqual({
      allowed: false,
      arm: 'public',
    });
  });

  it('private-deny: no org, no gate -> owner/admin only', () => {
    expect(classifyLakeAccess(lake(), ctx())).toEqual({ allowed: false, arm: 'private-deny' });
  });

  it('org-prereq: org-scoped lake, caller not in the org', () => {
    expect(classifyLakeAccess(lake({ organizationId: 'orgA' }), ctx({ organizationIds: ['orgB'] }))).toEqual({
      allowed: false,
      arm: 'org-prereq',
    });
  });

  it('requirement: held tag admits; missing tag denies - same arm either way', () => {
    expect(classifyLakeAccess(lake({ requiredUserTag: 'vip' }), ctx({ userTags: ['vip'] }))).toEqual({
      allowed: true,
      arm: 'requirement',
    });
    expect(classifyLakeAccess(lake({ requiredUserTag: 'vip' }), ctx({ userTags: [] }))).toEqual({
      allowed: false,
      arm: 'requirement',
    });
  });

  it('widening guard: an in-org tag holder passes, an out-of-org tag holder does NOT', () => {
    const orgLake = lake({ organizationId: 'orgA', requiredUserTag: 'vip' });
    expect(classifyLakeAccess(orgLake, ctx({ userTags: ['vip'], organizationIds: ['orgA'] })).allowed).toBe(true);
    expect(classifyLakeAccess(orgLake, ctx({ userTags: ['vip'], organizationIds: ['orgB'] }))).toEqual({
      allowed: false,
      arm: 'org-prereq',
    });
  });
});

describe('resolveReadGrant - the new explicit read-grant arm (user + org principals)', () => {
  it('true for a user-principal grant matching the caller (any role)', () => {
    expect(resolveReadGrant(ctx(), [grant('reader')])).toBe(true);
  });

  it('true for an org-principal grant when the caller is a MEMBER of that org', () => {
    expect(
      resolveReadGrant(ctx({ userId: 'u1', organizationIds: ['orgA'] }), [grant('reader', 'orgA', 'organization')])
    ).toBe(true);
  });

  it('true for an org owner/curator grant reaching a plain member (read follows membership)', () => {
    const c = ctx({ userId: 'u1', organizationIds: ['orgA'] });
    expect(resolveReadGrant(c, [grant('owner', 'orgA', 'organization')])).toBe(true);
    expect(resolveReadGrant(c, [grant('curator', 'orgA', 'organization')])).toBe(true);
  });

  it('false for an org-principal grant when the caller is NOT a member of that org', () => {
    expect(
      resolveReadGrant(ctx({ userId: 'u1', organizationIds: ['orgB'] }), [grant('reader', 'orgA', 'organization')])
    ).toBe(false);
  });

  it('false for a grant belonging to a different user', () => {
    expect(resolveReadGrant(ctx({ userId: 'u1' }), [grant('reader', 'u2')])).toBe(false);
  });

  it('false when the caller has no userId (fails closed on a blank identity)', () => {
    expect(resolveReadGrant(ctx({ userId: '' }), [grant('reader', '')])).toBe(false);
  });
});

describe('resolveLakeReadAccess - report-only vs enforce', () => {
  const readerCtx = ctx({ userId: 'reader1' });
  const readerGrant = [grant('reader', 'reader1')];

  it('report-only: a reader grant DIVERGES but does not change access (returns legacy deny)', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, readerGrant, { enforceReadGrants: false });
    expect(d).toMatchObject({
      allowed: false, // enforced decision stays legacy in report-only
      legacyAllowed: false,
      legacyArm: 'private-deny',
      readGrantAllows: true,
      resolvedAllowed: true,
      diverges: true,
      enforced: false,
    });
  });

  it('enforce: the same reader grant now opens the private lake', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, readerGrant, { enforceReadGrants: true });
    expect(d).toMatchObject({ allowed: true, resolvedAllowed: true, diverges: true, enforced: true });
  });

  it('org grant to a member: diverges in report-only, opens under enforce', () => {
    const memberCtx = ctx({ userId: 'm1', organizationIds: ['orgA'] });
    const orgGrant = [grant('reader', 'orgA', 'organization')];
    expect(resolveLakeReadAccess(lake(), memberCtx, orgGrant, { enforceReadGrants: false })).toMatchObject({
      allowed: false,
      readGrantAllows: true,
      diverges: true,
      enforced: false,
    });
    expect(resolveLakeReadAccess(lake(), memberCtx, orgGrant, { enforceReadGrants: true }).allowed).toBe(true);
  });

  it('org grant to a NON-member: no divergence, stays denied', () => {
    const outsider = ctx({ userId: 'x1', organizationIds: ['orgB'] });
    const d = resolveLakeReadAccess(lake(), outsider, [grant('reader', 'orgA', 'organization')], {
      enforceReadGrants: true,
    });
    expect(d).toMatchObject({ allowed: false, readGrantAllows: false, diverges: false });
  });

  it('owner grant does not diverge (already allowed by the legacy owner-admin arm)', () => {
    const d = resolveLakeReadAccess(lake(), readerCtx, [grant('owner', 'reader1')], { enforceReadGrants: false });
    expect(d).toMatchObject({ allowed: true, legacyArm: 'owner-admin', diverges: false });
  });

  it('no grant: a tag-matched lake is allowed by legacy, no divergence, in either mode', () => {
    const tagged = lake({ requiredUserTag: 'vip' });
    const c = ctx({ userId: 'u1', userTags: ['vip'] });
    expect(resolveLakeReadAccess(tagged, c, [], { enforceReadGrants: false })).toMatchObject({
      allowed: true,
      legacyArm: 'requirement',
      readGrantAllows: false,
      diverges: false,
    });
    expect(resolveLakeReadAccess(tagged, c, [], { enforceReadGrants: true }).allowed).toBe(true);
  });

  it('stranger with no grant is denied and does not diverge', () => {
    const d = resolveLakeReadAccess(lake(), ctx(), [], { enforceReadGrants: true });
    expect(d).toMatchObject({ allowed: false, diverges: false, legacyArm: 'private-deny' });
  });
});

describe('resolveEnforceReadGrants - fail-safe flag read', () => {
  it('unwired settings -> report-only (false)', async () => {
    expect(await resolveEnforceReadGrants(undefined)).toBe(false);
  });

  it('setting ON is gated by the code interlock: enforced only when READY, else report-only + warn', async () => {
    const settings = { getSettingsValue: vi.fn().mockResolvedValue(true) };
    const logger = { warn: vi.fn() };
    const result = await resolveEnforceReadGrants(settings, logger);
    expect(settings.getSettingsValue).toHaveBeenCalledWith(ENFORCE_LAKE_READ_GRANTS_KEY);
    // Enforced iff the source interlock is flipped; while it holds, a premature toggle stays
    // report-only and logs a warning so the accidental enable is visible.
    expect(result).toBe(READ_GRANT_ENFORCEMENT_READY);
    expect(logger.warn).toHaveBeenCalledTimes(READ_GRANT_ENFORCEMENT_READY ? 0 : 1);
  });

  it('a falsy value -> report-only', async () => {
    const settings = { getSettingsValue: vi.fn().mockResolvedValue(undefined) };
    expect(await resolveEnforceReadGrants(settings)).toBe(false);
  });

  it('a FAILED read degrades to report-only and warns (a failed read is not a yes)', async () => {
    const settings = { getSettingsValue: vi.fn().mockRejectedValue(new Error('boom')) };
    const logger = { warn: vi.fn() };
    expect(await resolveEnforceReadGrants(settings, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
