import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeAccessGrantDocument, type IDataLakeDocument } from '@bike4mind/common';
import {
  isOrgOwnershipCandidate,
  listLakeOwnershipCandidates,
  listOrgOwnershipCandidateIds,
  resolveLakeTransferAuthority,
  type LakeTransferActor,
} from './lakeOwnershipCandidates';

const lake = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({ id: 'lake1', createdByUserId: 'creator', organizationId: 'orgA', ...over }) as IDataLakeDocument;

const ownerGrant = (principalId: string): IDataLakeAccessGrantDocument =>
  ({
    dataLakeId: 'lake1',
    principalType: 'user',
    principalId,
    role: 'owner',
    grantedByUserId: 'g',
  }) as IDataLakeAccessGrantDocument;

const org = (over: { userId?: string; adminUserIds?: string[]; users?: { userId: string }[] } = {}) => ({
  name: 'Acme',
  userId: 'billingOwner',
  adminUserIds: [],
  users: [],
  ...over,
});

const makeAdapters = (
  over: {
    grants?: IDataLakeAccessGrantDocument[];
    org?: ReturnType<typeof org> | null;
    users?: { id: string; name?: string; username?: string; email?: string | null }[];
  } = {}
) => {
  const findByIds = vi.fn(async (ids: string[]) =>
    (over.users ?? ids.map(id => ({ id, name: id, email: `${id}@example.com` }))).filter(u => ids.includes(u.id))
  );
  const findById = vi.fn(async (_id: string) => (over.org === undefined ? org() : over.org));
  return {
    findByIds,
    findById,
    adapters: {
      db: {
        dataLakeAccessGrants: { listByLake: vi.fn(async () => over.grants ?? []) },
        users: { findByIds },
        organizations: { findById },
      },
    } as never,
  };
};

/** Every actor here belongs to orgA - the lake's org - unless a test is about NOT belonging. */
const creator: LakeTransferActor = { userId: 'creator', isAdmin: false, organizationIds: ['orgA'] };

describe('listOrgOwnershipCandidateIds', () => {
  it('spans the billing owner, appointed admins and the users[] ACL, de-duplicated', () => {
    const ids = listOrgOwnershipCandidateIds(
      org({ userId: 'billingOwner', adminUserIds: ['admin1', 'billingOwner'], users: [{ userId: 'member1' }] })
    );
    expect(ids.sort()).toEqual(['admin1', 'billingOwner', 'member1']);
  });

  it('drops blank ids rather than offering an unresolvable principal', () => {
    expect(listOrgOwnershipCandidateIds(org({ userId: '', users: [{ userId: '' }, { userId: 'member1' }] }))).toEqual([
      'member1',
    ]);
  });

  it('admits a share-only member the READ gate would not - owning a lake grants its own access', () => {
    // Deliberately wider than assembleLakeAccessView's ORG_MEMBER_PERMISSIONS: a new owner does not
    // need pre-existing read access. Encoded as a test so the two sets are not "fixed" into agreement.
    const shareOnly = org({ users: [{ userId: 'shareOnly' } as never] });
    expect(isOrgOwnershipCandidate(shareOnly, 'shareOnly')).toBe(true);
  });

  it('rejects a non-member and a blank id', () => {
    expect(isOrgOwnershipCandidate(org(), 'stranger')).toBe(false);
    expect(isOrgOwnershipCandidate(org(), '')).toBe(false);
  });
});

describe('resolveLakeTransferAuthority', () => {
  it('allows a platform admin, the effective owner, and an admin of the lake org', () => {
    expect(resolveLakeTransferAuthority(lake(), { userId: 'anyone', isAdmin: true, organizationIds: [] }).allowed).toBe(
      true
    );
    expect(resolveLakeTransferAuthority(lake(), creator).allowed).toBe(true);
    expect(
      resolveLakeTransferAuthority(lake(), {
        userId: 'orgAdmin',
        isAdmin: false,
        administeredOrgIds: ['orgA'],
        // Not on the org's users[] ACL: an appointed admin need not be, and the succession path
        // this rung exists for must survive that.
        organizationIds: [],
      }).allowed
    ).toBe(true);
  });

  it('refuses a curator - managing a lake is not owning it', () => {
    const curator: LakeTransferActor = { userId: 'cur', isAdmin: false, organizationIds: ['orgA'] };
    const grants = [{ principalType: 'user' as const, principalId: 'cur', role: 'curator' as const }];
    expect(resolveLakeTransferAuthority(lake(), curator, grants).allowed).toBe(false);
  });

  it('follows the owner GRANT, not the immutable creator, once ownership has moved', () => {
    const grants = [{ principalType: 'user' as const, principalId: 'newOwner', role: 'owner' as const }];
    expect(resolveLakeTransferAuthority(lake(), creator, grants).allowed).toBe(false);
    expect(
      resolveLakeTransferAuthority(lake(), { userId: 'newOwner', isAdmin: false, organizationIds: ['orgA'] }, grants)
        .allowed
    ).toBe(true);
  });

  it('refuses a fallback (registry) lake, which has no document to hang an owner grant on', () => {
    expect(
      resolveLakeTransferAuthority(lake({ id: DATA_LAKES[0].id }), { userId: 'x', isAdmin: true, organizationIds: [] })
        .allowed
    ).toBe(false);
  });

  it('reports isOwner, which the audit trail records the transfer rung from', () => {
    // Must come from the same call that authorized the transfer: re-deriving it separately is how a
    // config-change record ends up naming a rung the gate never used.
    expect(resolveLakeTransferAuthority(lake(), creator).isOwner).toBe(true);
    expect(resolveLakeTransferAuthority(lake(), { userId: 'root', isAdmin: true, organizationIds: [] }).isOwner).toBe(
      false
    );
    expect(
      resolveLakeTransferAuthority(lake({ id: DATA_LAKES[0].id }), creator).isOwner,
      'a fallback lake authorizes nobody, so it must not report ownership either'
    ).toBe(false);
  });

  it('refuses an owner who has LEFT the lake org - a grant outlives the membership behind it', () => {
    // Nothing revokes lake grants when someone leaves an organization, so without this the stale
    // grant would keep authorizing a transfer - and turn the candidate listing into a live read of
    // the org's current roster, emails included.
    const departed: LakeTransferActor = { userId: 'creator', isAdmin: false, organizationIds: [] };
    expect(resolveLakeTransferAuthority(lake(), departed).allowed).toBe(false);
    expect(resolveLakeTransferAuthority(lake(), creator).allowed).toBe(true);
  });

  it('leaves a PERSONAL lake unaffected by the membership rule - there is no org to belong to', () => {
    const personal = lake({ organizationId: undefined });
    expect(
      resolveLakeTransferAuthority(personal, { userId: 'creator', isAdmin: false, organizationIds: [] }).allowed
    ).toBe(true);
  });

  it('exempts a platform admin, who belongs to no org in particular', () => {
    expect(resolveLakeTransferAuthority(lake(), { userId: 'root', isAdmin: true, organizationIds: [] }).allowed).toBe(
      true
    );
  });

  it('flags the org-admin-only rung, which the consent guard keys off', () => {
    const orgAdmin: LakeTransferActor = {
      userId: 'orgAdmin',
      isAdmin: false,
      administeredOrgIds: ['orgA'],
      organizationIds: ['orgA'],
    };
    expect(resolveLakeTransferAuthority(lake(), orgAdmin).viaOrgAdminOnly).toBe(true);
    // An org admin who is ALSO the owner is not acting purely by that rung, so may name themselves.
    expect(resolveLakeTransferAuthority(lake({ createdByUserId: 'orgAdmin' }), orgAdmin).viaOrgAdminOnly).toBe(false);
    expect(
      resolveLakeTransferAuthority(lake(), { userId: 'root', isAdmin: true, organizationIds: [] }).viaOrgAdminOnly
    ).toBe(false);
  });
});

describe('listLakeOwnershipCandidates', () => {
  it("lists the owning org's members, excluding the current owner", async () => {
    const { adapters, findById } = makeAdapters({
      org: org({ users: [{ userId: 'creator' }, { userId: 'member1' }] }),
    });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result.scope).toBe('organization');
    expect(result.organizationName).toBe('Acme');
    expect(result.candidates.map(c => c.userId).sort()).toEqual(['billingOwner', 'member1']);
    // WHICH org is read is the property that carries the email exposure: candidates must come from
    // the LAKE's org, never the actor's. Pinned here because the mock would answer any id.
    expect(findById).toHaveBeenCalledWith('orgA');
  });

  it('reads the LAKE org even when the actor administers another one', async () => {
    const { adapters, findById } = makeAdapters({ org: org({ users: [{ userId: 'member1' }] }) });
    await listLakeOwnershipCandidates(
      lake(),
      { userId: 'creator', isAdmin: false, organizationIds: ['orgA', 'orgB'], administeredOrgIds: ['orgB'] },
      adapters
    );
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith('orgA');
  });

  it('offers nothing to an owner who has left the org, rather than disclosing its roster', async () => {
    const { adapters, findByIds } = makeAdapters({ org: org({ users: [{ userId: 'member1' }] }) });
    const result = await listLakeOwnershipCandidates(
      lake(),
      { userId: 'creator', isAdmin: false, organizationIds: [] },
      adapters
    );
    expect(result.candidates).toEqual([]);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it("carries the lake's content gate, which ownership bypasses, so the UI can say so", async () => {
    const { adapters } = makeAdapters({ org: org({ users: [{ userId: 'member1' }] }) });
    const gated = lake({ requiredUserTag: 'phi', requiredEntitlement: 'clinical' });
    const result = await listLakeOwnershipCandidates(gated, creator, adapters);
    expect(result.gate).toEqual({ requiredUserTag: 'phi', requiredEntitlement: 'clinical' });
    // The gate must not narrow the option set - a new owner does not need to satisfy it.
    expect(result.candidates.map(c => c.userId)).toContain('member1');
  });

  it('omits the gate entirely for an ungated lake, so absent means ungated', async () => {
    const { adapters } = makeAdapters({ org: org({ users: [{ userId: 'member1' }] }) });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result.gate).toBeUndefined();
  });

  it('excludes an owner held by GRANT, not just the creator', async () => {
    const { adapters } = makeAdapters({
      grants: [ownerGrant('member1')],
      org: org({ users: [{ userId: 'member1' }] }),
    });
    const result = await listLakeOwnershipCandidates(
      lake(),
      { userId: 'member1', isAdmin: false, organizationIds: ['orgA'] },
      adapters
    );
    expect(result.candidates.map(c => c.userId)).not.toContain('member1');
  });

  it('excludes an org admin from their OWN candidate list - the consent guard would refuse it', async () => {
    // Offering an option the write path always rejects is worse than offering none.
    const { adapters } = makeAdapters({ org: org({ adminUserIds: ['orgAdmin'], users: [{ userId: 'member1' }] }) });
    const result = await listLakeOwnershipCandidates(
      lake(),
      { userId: 'orgAdmin', isAdmin: false, administeredOrgIds: ['orgA'], organizationIds: ['orgA'] },
      adapters
    );
    expect(result.candidates.map(c => c.userId)).not.toContain('orgAdmin');
    expect(result.candidates.map(c => c.userId)).toContain('member1');
  });

  it('keeps a platform admin selectable for themselves - they are exempt from the consent guard', async () => {
    const { adapters } = makeAdapters({ org: org({ adminUserIds: ['root'] }) });
    const result = await listLakeOwnershipCandidates(
      lake(),
      { userId: 'root', isAdmin: true, organizationIds: [] },
      adapters
    );
    expect(result.candidates.map(c => c.userId)).toContain('root');
  });

  it('returns scope personal with no candidates for a lake in no organization', async () => {
    const { adapters, findByIds } = makeAdapters();
    const result = await listLakeOwnershipCandidates(lake({ organizationId: undefined }), creator, adapters);
    expect(result).toEqual({ scope: 'personal', candidates: [] });
    // No global user enumeration stands in for the missing membership relation.
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('returns an empty list rather than throwing when the actor may not transfer', async () => {
    const { adapters, findByIds } = makeAdapters();
    const result = await listLakeOwnershipCandidates(
      lake(),
      { userId: 'stranger', isAdmin: false, organizationIds: ['orgA'] },
      adapters
    );
    expect(result.candidates).toEqual([]);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('keeps the org name when the org has nobody else eligible, so the UI can say which org', async () => {
    const { adapters } = makeAdapters({ org: org({ userId: 'creator', adminUserIds: [], users: [] }) });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result).toEqual({ scope: 'organization', candidates: [], organizationName: 'Acme' });
  });

  it('survives an unresolvable org without offering candidates', async () => {
    const { adapters } = makeAdapters({ org: null });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result).toEqual({ scope: 'organization', candidates: [] });
  });

  it('carries name and email, falling back to username, and sorts by display name', async () => {
    const { adapters } = makeAdapters({
      org: org({ users: [{ userId: 'zoe' }, { userId: 'amy' }, { userId: 'nameless' }] }),
      users: [
        { id: 'billingOwner', name: 'Mid', email: 'mid@example.com' },
        { id: 'zoe', name: 'Zoe', email: 'zoe@example.com' },
        { id: 'amy', name: 'Amy', email: 'amy@example.com' },
        { id: 'nameless', username: 'nameless-handle', email: null },
      ],
    });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result.candidates.map(c => c.name)).toEqual(['Amy', 'Mid', 'nameless-handle', 'Zoe']);
    // A null email must read as "unknown", never as the string "null" in a picker.
    expect(result.candidates.find(c => c.userId === 'nameless')?.email).toBeUndefined();
    expect(result.candidates.find(c => c.userId === 'amy')?.email).toBe('amy@example.com');
  });

  it('drops a member whose user record no longer resolves', async () => {
    const { adapters } = makeAdapters({
      org: org({ users: [{ userId: 'ghost' }] }),
      users: [{ id: 'billingOwner', name: 'Owner', email: 'owner@example.com' }],
    });
    const result = await listLakeOwnershipCandidates(lake(), creator, adapters);
    expect(result.candidates.map(c => c.userId)).toEqual(['billingOwner']);
  });
});
