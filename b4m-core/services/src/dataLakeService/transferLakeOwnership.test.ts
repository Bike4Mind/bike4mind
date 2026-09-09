import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeAccessGrantDocument, type IDataLakeDocument } from '@bike4mind/common';
import { transferLakeOwnership } from './transferLakeOwnership';
import type { LakeTransferActor } from './lakeOwnershipCandidates';

const lake = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({ id: 'lake1', createdByUserId: 'creator', organizationId: undefined, ...over }) as IDataLakeDocument;

const activeGrant = (over: Partial<IDataLakeAccessGrantDocument>): IDataLakeAccessGrantDocument =>
  ({
    dataLakeId: 'lake1',
    principalType: 'user',
    principalId: 'x',
    role: 'owner',
    grantedByUserId: 'g',
    ...over,
  }) as IDataLakeAccessGrantDocument;

const makeAdapters = (
  over: {
    lakeDoc?: IDataLakeDocument | null;
    grants?: IDataLakeAccessGrantDocument[];
    userExists?: boolean;
    org?: { userId?: string; adminUserIds?: string[]; users?: { userId: string }[] } | null;
  } = {}
) => {
  const upsertGrant = vi.fn(async input => activeGrant(input));
  const update = vi.fn(async () => (over.lakeDoc === undefined ? lake() : over.lakeDoc));
  return {
    upsertGrant,
    update,
    adapters: {
      db: {
        dataLakes: { findById: vi.fn(async () => (over.lakeDoc === undefined ? lake() : over.lakeDoc)), update },
        dataLakeAccessGrants: {
          listByLake: vi.fn(async () => over.grants ?? []),
          upsertGrant,
        },
        users: { findById: vi.fn(async () => (over.userExists === false ? null : ({ id: 'newOwner' } as never))) },
        organizations: { findById: vi.fn(async () => (over.org === undefined ? null : over.org)) },
      },
    } as never,
  };
};

// Belongs to org1, the org every org-scoped lake below is scoped to: the transfer rule requires the
// actor to still be a member, not merely to hold the grant.
const owner: LakeTransferActor = { userId: 'creator', isAdmin: false, organizationIds: ['org1'] };

describe('transferLakeOwnership', () => {
  it('refuses a fallback (registry) lake - it has no document to hang a grant on', async () => {
    const { adapters } = makeAdapters({ lakeDoc: lake({ id: DATA_LAKES[0].id }) });
    await expect(transferLakeOwnership(owner, DATA_LAKES[0].id, 'newOwner', adapters)).rejects.toThrow(
      /built into the platform/i
    );
  });

  it('rejects an actor who is neither admin, effective owner, nor an admin of the lake org', async () => {
    const { adapters, upsertGrant } = makeAdapters();
    await expect(
      transferLakeOwnership({ userId: 'stranger', isAdmin: false, organizationIds: [] }, 'lake1', 'newOwner', adapters)
    ).rejects.toThrow(/do not have permission to transfer/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('rejects a new owner that does not exist', async () => {
    const { adapters } = makeAdapters({ userExists: false });
    await expect(transferLakeOwnership(owner, 'lake1', 'ghost', adapters)).rejects.toThrow(/could not be found/i);
  });

  it('transfers by granting the new owner and demoting the prior (fallback) creator to curator', async () => {
    const { adapters, upsertGrant, update } = makeAdapters();
    const result = await transferLakeOwnership(owner, 'lake1', 'newOwner', adapters);

    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalType: 'user', principalId: 'newOwner', role: 'owner' })
    );
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalType: 'user', principalId: 'creator', role: 'curator' })
    );
    expect(result).toEqual({ newOwnerUserId: 'newOwner', demotedUserIds: ['creator'] });
    // createdByUserId is never mutated. The service does now write the lake document - but only to
    // carry the config-write actor stamp - so the guard is on the PAYLOAD, not on the absence of a
    // write: ownership still moves entirely through the grants.
    expect(update).toHaveBeenCalledWith({ id: 'lake1', lastUpdatedByUserId: 'creator' });
    for (const [payload] of update.mock.calls) {
      expect(payload).not.toHaveProperty('createdByUserId');
    }
  });

  it('still reports a completed transfer when the stamp write fails, and says so', async () => {
    // The grants above have already moved ownership, so throwing here would report a failure that
    // did not happen and invite a retry of a finished operation - but a silent swallow would leave
    // the stamp quietly naming an older, smaller edit.
    const { adapters, update } = makeAdapters();
    update.mockRejectedValueOnce(new Error('mongo down'));
    const logger = { warn: vi.fn() };

    await expect(transferLakeOwnership(owner, 'lake1', 'newOwner', { ...adapters, logger } as never)).resolves.toEqual({
      newOwnerUserId: 'newOwner',
      demotedUserIds: ['creator'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('actor stamp did not persist'),
      expect.objectContaining({ dataLakeId: 'lake1' })
    );
  });

  it('reports a stamp that matched no document, which resolves null instead of throwing', async () => {
    // `BaseModel.update` is a findOneAndUpdate: a lake deleted between this function's opening
    // findById and the final stamp write resolves NULL rather than throwing, so the catch never sees
    // it. Without the result check that failure is completely silent.
    const { adapters, update } = makeAdapters();
    update.mockResolvedValueOnce(null as never);
    const logger = { warn: vi.fn() };

    await expect(transferLakeOwnership(owner, 'lake1', 'newOwner', { ...adapters, logger } as never)).resolves.toEqual({
      newOwnerUserId: 'newOwner',
      demotedUserIds: ['creator'],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not found for the actor stamp'),
      expect.objectContaining({ dataLakeId: 'lake1' })
    );
  });

  it('still reports the failed stamp when no logger is wired, rather than going silent', async () => {
    // `logger` is optional on the adapters, so a caller that omits it must not turn a swallowed
    // failure into no output at all - the only other symptom is a stamp naming an older, smaller edit.
    const { adapters, update } = makeAdapters();
    update.mockRejectedValueOnce(new Error('mongo down'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(transferLakeOwnership(owner, 'lake1', 'newOwner', adapters)).resolves.toEqual({
        newOwnerUserId: 'newOwner',
        demotedUserIds: ['creator'],
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('actor stamp did not persist'),
        expect.objectContaining({ dataLakeId: 'lake1' })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not write the lake at all when the actor has no id to attribute', async () => {
    // The stamp write exists only to record WHO; with nobody to record it must not cost a round
    // trip, and it must not clear a prior stamp that WAS attributable.
    const { adapters, update } = makeAdapters();
    await transferLakeOwnership({ userId: '', isAdmin: true, organizationIds: [] }, 'lake1', 'newOwner', adapters);

    expect(update).not.toHaveBeenCalled();
  });

  it('demotes a PRIOR owner-grant holder (not the creator) when ownership was already transferred once', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      grants: [activeGrant({ principalId: 'prevOwner', role: 'owner' })],
    });
    // prevOwner is the current effective owner and may transfer onward.
    const result = await transferLakeOwnership(
      { userId: 'prevOwner', isAdmin: false, organizationIds: [] },
      'lake1',
      'newOwner',
      adapters
    );
    expect(result.demotedUserIds).toEqual(['prevOwner']);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'prevOwner', role: 'curator' }));
  });

  it('is a no-op demotion when transferring to the current sole owner', async () => {
    const { adapters, upsertGrant } = makeAdapters();
    const result = await transferLakeOwnership(owner, 'lake1', 'creator', adapters);
    expect(result.demotedUserIds).toEqual([]);
    // Only the owner upsert runs; nobody is demoted to curator.
    expect(upsertGrant).toHaveBeenCalledTimes(1);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'creator', role: 'owner' }));
  });

  it('org lake: refuses a new owner who is not a member of the owning org', async () => {
    const { adapters } = makeAdapters({
      lakeDoc: lake({ organizationId: 'org1' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'creator' }] },
    });
    await expect(transferLakeOwnership(owner, 'lake1', 'newOwner', adapters)).rejects.toThrow(
      /must belong to the organization/i
    );
  });

  it('org lake: allows an org admin to transfer to an org member (orphaned-creator succession)', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      lakeDoc: lake({ organizationId: 'org1', createdByUserId: 'departed' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'newOwner' }] },
    });
    const orgAdmin: LakeTransferActor = {
      userId: 'orgAdmin',
      isAdmin: false,
      administeredOrgIds: ['org1'],
      organizationIds: ['org1'],
    };
    const result = await transferLakeOwnership(orgAdmin, 'lake1', 'newOwner', adapters);
    expect(result.newOwnerUserId).toBe('newOwner');
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'newOwner', role: 'owner' }));
  });

  it('consent guard (B4): forbids an org admin from transferring the lake to THEMSELVES', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      lakeDoc: lake({ organizationId: 'org1', createdByUserId: 'departed' }),
      org: { userId: 'billing', adminUserIds: ['orgAdmin'], users: [{ userId: 'orgAdmin' }] },
    });
    const orgAdmin: LakeTransferActor = {
      userId: 'orgAdmin',
      isAdmin: false,
      administeredOrgIds: ['org1'],
      organizationIds: ['org1'],
    };
    await expect(transferLakeOwnership(orgAdmin, 'lake1', 'orgAdmin', adapters)).rejects.toThrow(
      /cannot transfer a data lake to themselves/i
    );
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('org lake: refuses an owner who has left the owning org, even holding the owner grant', async () => {
    // Lake grants are not revoked on org departure, so the grant alone must not authorize a write
    // that hands the lake on (and, through the picker, discloses the org's roster).
    const { adapters, upsertGrant } = makeAdapters({
      lakeDoc: lake({ organizationId: 'org1' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'newOwner' }] },
    });
    await expect(
      transferLakeOwnership({ userId: 'creator', isAdmin: false, organizationIds: [] }, 'lake1', 'newOwner', adapters)
    ).rejects.toThrow(/do not have permission to transfer/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('a platform admin MAY transfer a lake to themselves (superuser, exempt from the consent guard)', async () => {
    const { adapters, upsertGrant } = makeAdapters({ lakeDoc: lake({ createdByUserId: 'someoneElse' }) });
    const result = await transferLakeOwnership(
      { userId: 'root', isAdmin: true, organizationIds: [] },
      'lake1',
      'root',
      adapters
    );
    expect(result.newOwnerUserId).toBe('root');
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'root', role: 'owner' }));
  });

  it('the current owner MAY transfer to themselves (no-op-ish; exempt from the consent guard)', async () => {
    // Owner authorized as effective owner, not via the org-admin rung, so the guard does not apply.
    const { adapters } = makeAdapters({
      lakeDoc: lake({ organizationId: 'org1', createdByUserId: 'creator' }),
      org: { users: [{ userId: 'creator' }] },
    });
    const result = await transferLakeOwnership(owner, 'lake1', 'creator', adapters);
    expect(result.newOwnerUserId).toBe('creator');
  });
});
