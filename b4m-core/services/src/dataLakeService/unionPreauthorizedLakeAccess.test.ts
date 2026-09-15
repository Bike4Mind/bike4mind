import { describe, it, expect, vi } from 'vitest';
import { unionPreauthorizedLakeAccess } from './unionPreauthorizedLakeAccess';
import type { ResolvedLakeAccessSet } from './narrowLakeAccessToSession';

/** The admitted maintainer. Deliberately NOT the fixture lake's creator - see managedLake. */
const ACTOR = 'maintainer-1';

const access = (): ResolvedLakeAccessSet => ({
  dataLakeTags: ['datalake:alpha'],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: ['alpha:'],
  lakes: [
    {
      id: 'alpha',
      name: 'alpha',
      slug: 'alpha',
      datalakeTag: 'datalake:alpha',
      fileTagPrefix: 'alpha:',
      membership: { kind: 'owned', datalakeTag: 'datalake:alpha', fileTagPrefix: 'alpha:', creatorUserId: 'owner-1' },
      source: 'dynamic',
    },
  ] as ResolvedLakeAccessSet['lakes'],
});

const managedLake = (overrides: Partial<{ id: string; status: string; organizationId: string }> = {}) => ({
  id: overrides.id ?? 'managed',
  name: 'Managed Lake',
  slug: 'managed-lake',
  datalakeTag: 'datalake:managed',
  fileTagPrefix: 'managed:',
  status: overrides.status ?? 'active',
  // Someone else's lake ON PURPOSE: the whole admission exists for a manager who is not the
  // creator, so a fixture the actor created would pass the re-check on the owner rung and prove
  // nothing about the grant/org rungs the real case depends on.
  createdByUserId: 'other-user',
  organizationId: overrides.organizationId,
});

const CURATOR_GRANT = { dataLakeId: 'managed', principalType: 'user', principalId: ACTOR, role: 'curator' };

const deps = (
  opts: {
    findById?: ReturnType<typeof vi.fn>;
    grants?: unknown[] | null;
    adminOrgIds?: string[] | null;
  } = {}
) => ({
  dataLakes: { findById: opts.findById ?? vi.fn().mockResolvedValue(managedLake()) } as never,
  // `null` means "adapter not wired at all", which is a different case from "wired and empty".
  ...(opts.grants === null
    ? {}
    : {
        dataLakeAccessGrants: {
          listActiveByLakes: vi.fn().mockResolvedValue(opts.grants ?? [CURATOR_GRANT]),
        } as never,
      }),
  ...(opts.adminOrgIds === null
    ? {}
    : { organizations: { findIdsWithAdminRights: vi.fn().mockResolvedValue(opts.adminOrgIds ?? []) } as never }),
});

describe('unionPreauthorizedLakeAccess', () => {
  it('adds a pre-authorized lake the caller could not otherwise reach', async () => {
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps());

    expect(out.lakes.map(l => l.id)).toEqual(['alpha', 'managed']);
    expect(out.dataLakeTags).toEqual(['datalake:alpha', 'datalake:managed']);
    expect(out.scopedTagPrefixes).toEqual(['alpha:', 'managed:']);
  });

  it('is a no-op when no ids are pre-authorized', async () => {
    const findById = vi.fn();
    const out = await unionPreauthorizedLakeAccess(access(), undefined, ACTOR, deps({ findById }));

    expect(out).toEqual(access());
    expect(findById).not.toHaveBeenCalled();
  });

  it('does not re-fetch a lake already present in the resolved set', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake());
    const out = await unionPreauthorizedLakeAccess(access(), ['alpha'], ACTOR, deps({ findById }));

    expect(findById).not.toHaveBeenCalled();
    expect(out).toEqual(access());
  });

  it('drops a pre-authorized id that no longer resolves to an active lake', async () => {
    const findById = vi.fn().mockResolvedValue(managedLake({ status: 'archived' }));
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps({ findById }));

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });

  it('drops a pre-authorized id that no longer exists', async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const out = await unionPreauthorizedLakeAccess(access(), ['gone'], ACTOR, deps({ findById }));

    expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
  });

  it('is a no-op when the context carries no dataLakes repository (e.g. a suppressed arm)', async () => {
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, {});

    expect(out).toEqual(access());
  });

  // #2243: retrieval derives its membership arms from `lakes`, so a unioned entry must carry a
  // real membership scope, not a stand-in - lakeMembershipScope resolves it from the lake's own
  // ownership/organization fields, the same derivation the rest of this file's entries use.
  it('gives the unioned entry a real membership scope, not a placeholder', async () => {
    const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps());

    const entry = out.lakes.find(l => l.id === 'managed');
    expect(entry?.membership).toMatchObject({ creatorUserId: 'other-user' });
  });

  // The reason this function re-derives the gate instead of trusting the session's record. The
  // session document is unchanged in all three of these - only the actor's current rights differ.
  describe('per-turn manage re-check', () => {
    it('revokes an admitted lake once the manage grant is gone', async () => {
      const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps({ grants: [] }));

      expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
      expect(out.dataLakeTags).not.toContain('datalake:managed');
      expect(out.scopedTagPrefixes).not.toContain('managed:');
    });

    it('revokes an admitted lake when the grant now names someone else', async () => {
      const grants = [{ ...CURATOR_GRANT, principalId: 'someone-else' }];
      const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps({ grants }));

      expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
    });

    it('keeps an admitted lake held on the org-admin rung rather than a grant', async () => {
      const findById = vi.fn().mockResolvedValue(managedLake({ organizationId: 'org-1' }));
      const out = await unionPreauthorizedLakeAccess(
        access(),
        ['managed'],
        ACTOR,
        deps({ findById, grants: [], adminOrgIds: ['org-1'] })
      );

      expect(out.lakes.map(l => l.id)).toEqual(['alpha', 'managed']);
    });

    it('revokes when the actor administers a different org than the lake', async () => {
      const findById = vi.fn().mockResolvedValue(managedLake({ organizationId: 'org-1' }));
      const out = await unionPreauthorizedLakeAccess(
        access(),
        ['managed'],
        ACTOR,
        deps({ findById, grants: [], adminOrgIds: ['org-2'] })
      );

      expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
    });

    // Fail-closed on an unwired host: without a grant reader the curator rung cannot resolve, and
    // the admission is denied rather than taken on the session's word.
    it('revokes a grant-held lake when no grant reader is wired', async () => {
      const out = await unionPreauthorizedLakeAccess(access(), ['managed'], ACTOR, deps({ grants: null }));

      expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
    });

    it('revokes an org-held lake when no organization reader is wired', async () => {
      const findById = vi.fn().mockResolvedValue(managedLake({ organizationId: 'org-1' }));
      const out = await unionPreauthorizedLakeAccess(
        access(),
        ['managed'],
        ACTOR,
        deps({ findById, grants: [], adminOrgIds: null })
      );

      expect(out.lakes.map(l => l.id)).toEqual(['alpha']);
    });

    it('costs one grant read and one org read regardless of how many lakes were admitted', async () => {
      const findById = vi.fn(async (id: string) => managedLake({ id }));
      const d = deps({
        findById,
        grants: [
          { ...CURATOR_GRANT, dataLakeId: 'm1' },
          { ...CURATOR_GRANT, dataLakeId: 'm2' },
          { ...CURATOR_GRANT, dataLakeId: 'm3' },
        ],
      });
      const out = await unionPreauthorizedLakeAccess(access(), ['m1', 'm2', 'm3'], ACTOR, d);

      expect(out.lakes.map(l => l.id)).toEqual(['alpha', 'm1', 'm2', 'm3']);
      expect(
        (d.dataLakeAccessGrants as unknown as { listActiveByLakes: ReturnType<typeof vi.fn> }).listActiveByLakes
      ).toHaveBeenCalledTimes(1);
      expect(
        (d.organizations as unknown as { findIdsWithAdminRights: ReturnType<typeof vi.fn> }).findIdsWithAdminRights
      ).toHaveBeenCalledTimes(1);
    });
  });
});
