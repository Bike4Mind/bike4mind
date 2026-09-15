import { describe, it, expect, vi } from 'vitest';
import { filterStillManagedLakes } from './filterStillManagedLakes';
import type { IDataLakeDocument } from '@bike4mind/common';

const ACTOR = 'maintainer-1';

const lake = (overrides: Partial<{ id: string; createdByUserId: string; organizationId: string }> = {}) =>
  ({
    id: overrides.id ?? 'managed',
    createdByUserId: overrides.createdByUserId ?? 'other-user',
    organizationId: overrides.organizationId,
  }) as unknown as IDataLakeDocument;

const readers = (grants: unknown[] = [], adminOrgIds: string[] = []) => ({
  dataLakeAccessGrants: { listActiveByLakes: vi.fn().mockResolvedValue(grants) } as never,
  organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue(adminOrgIds) } as never,
});

describe('filterStillManagedLakes', () => {
  it('spends nothing on an empty set - the guarantee that makes a per-tool-call re-check affordable', async () => {
    const db = readers();
    expect(await filterStillManagedLakes([], ACTOR, db)).toEqual([]);
    expect(
      (db.dataLakeAccessGrants as never as { listActiveByLakes: ReturnType<typeof vi.fn> }).listActiveByLakes
    ).not.toHaveBeenCalled();
    expect(
      (db.organizations as never as { findIdsWithAdminRights: ReturnType<typeof vi.fn> }).findIdsWithAdminRights
    ).not.toHaveBeenCalled();
  });

  it('keeps the effective owner and drops everyone else', async () => {
    const lakes = [lake({ id: 'mine', createdByUserId: ACTOR }), lake({ id: 'theirs' })];
    const kept = await filterStillManagedLakes(lakes, ACTOR, readers());

    expect(kept.map(l => l.id)).toEqual(['mine']);
  });

  it('keeps a curator-granted lake and drops one granted to someone else', async () => {
    const grants = [
      { dataLakeId: 'a', principalType: 'user', principalId: ACTOR, role: 'curator' },
      { dataLakeId: 'b', principalType: 'user', principalId: 'other', role: 'curator' },
    ];
    const kept = await filterStillManagedLakes([lake({ id: 'a' }), lake({ id: 'b' })], ACTOR, readers(grants));

    expect(kept.map(l => l.id)).toEqual(['a']);
  });

  it('keeps a lake in an org the actor administers', async () => {
    const lakes = [lake({ id: 'a', organizationId: 'org-1' }), lake({ id: 'b', organizationId: 'org-2' })];
    const kept = await filterStillManagedLakes(lakes, ACTOR, readers([], ['org-1']));

    expect(kept.map(l => l.id)).toEqual(['a']);
  });

  // The one rung this MUST NOT inherit from canManageLake's defaults. The re-check builds its actor
  // with isAdmin: false to mirror pages/api/sessions/create.ts, which also refuses to admit a lake
  // on platform-admin alone; a re-check that admitted admins would widen past its own create gate.
  it('does not admit a platform admin who manages nothing on this lake', async () => {
    const kept = await filterStillManagedLakes([lake()], 'a-platform-admin', readers());

    expect(kept).toEqual([]);
  });

  it('degrades closed when neither reader is wired', async () => {
    const kept = await filterStillManagedLakes([lake({ id: 'a', organizationId: 'org-1' })], ACTOR, {});

    expect(kept).toEqual([]);
  });

  // The creator rung reads no grants, so it is the one rung that would still pass with the grant
  // repo unwired - and an ownership TRANSFER lives in an owner grant that never touches
  // createdByUserId, so it would pass for someone who no longer owns the lake. Refused instead.
  it('refuses the creator rung when no grant reader is wired', async () => {
    const kept = await filterStillManagedLakes([lake({ id: 'mine', createdByUserId: ACTOR })], ACTOR, {
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) } as never,
    });

    expect(kept).toEqual([]);
  });

  it('still admits the org-admin rung with no grant reader - the refusal is scoped to the creator', async () => {
    const kept = await filterStillManagedLakes([lake({ id: 'a', organizationId: 'org-1' })], ACTOR, {
      organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue(['org-1']) } as never,
    });

    expect(kept.map(l => l.id)).toEqual(['a']);
  });

  it('batches into a single grant read across every lake', async () => {
    const db = readers();
    await filterStillManagedLakes([lake({ id: 'a' }), lake({ id: 'b' }), lake({ id: 'c' })], ACTOR, db);

    const listActiveByLakes = (db.dataLakeAccessGrants as never as { listActiveByLakes: ReturnType<typeof vi.fn> })
      .listActiveByLakes;
    expect(listActiveByLakes).toHaveBeenCalledTimes(1);
    expect(listActiveByLakes.mock.calls[0][0]).toEqual(['a', 'b', 'c']);
  });
});
