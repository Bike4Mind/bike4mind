import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listArchivedDataLakes, listDeletedDataLakes, listTransitionalDataLakes } from './listDataLakes';

/**
 * `findAccessible`'s owner arm is creator provenance, and a creator who has been transferred or
 * departed off a lake is no longer its effective owner. The arm itself is pinned in
 * `packages/database` (against real Mongo) and the exclusion set in `resolveLakeReadAccess.test.ts`;
 * what is pinned HERE is the wiring - that each list path actually resolves the set and hands it to
 * the repo. A lister that quietly stopped passing it would leak with every other test still green.
 */

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'alice',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...overrides,
});

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'handed-on',
    name: 'Handed On',
    slug: 'handed-on',
    fileTagPrefix: 'ho:',
    datalakeTag: 'datalake:handed-on',
    createdByUserId: 'alice',
    organizationId: 'orgA',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

/** Alice created `handed-on`; the departure hand-off gave its owner grant to the billing owner. */
const handedOnRepos = (lakes: IDataLakeDocument[]) => {
  const dataLakes = {
    // Honours the exclusion the way the Mongo query does, so these assert the row set a caller
    // actually receives rather than only the argument the repo was called with.
    findAccessible: vi.fn(async (_ctx: AccessContext, opts?: { supersededOwnLakeIds?: string[] }) =>
      lakes.filter(l => !(opts?.supersededOwnLakeIds ?? []).includes(l.id))
    ),
    find: vi.fn().mockResolvedValue([]),
    findIdsCreatedBy: vi.fn().mockResolvedValue(['handed-on']),
  };
  const dataLakeAccessGrants = {
    listActiveByLakes: vi
      .fn()
      .mockResolvedValue([
        { dataLakeId: 'handed-on', principalType: 'user', principalId: 'billing-owner', role: 'owner' },
      ]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
  };
  return { dataLakes, dataLakeAccessGrants };
};

describe('list paths - a creator superseded as owner loses the listing', () => {
  it('drops the row from the browse list', async () => {
    const { dataLakes, dataLakeAccessGrants } = handedOnRepos([lake()]);

    const result = await listDataLakes(ctx(), { db: { dataLakes, dataLakeAccessGrants } });

    expect(result.map(l => l.id)).not.toContain('handed-on');
    expect(dataLakes.findAccessible).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: ['handed-on'] })
    );
  });

  it('keeps a lake the caller still owns - the exclusion is ownership, not provenance', async () => {
    const { dataLakes, dataLakeAccessGrants } = handedOnRepos([lake()]);
    dataLakeAccessGrants.listActiveByLakes.mockResolvedValue([
      { dataLakeId: 'handed-on', principalType: 'user', principalId: 'alice', role: 'owner' },
    ]);

    const result = await listDataLakes(ctx(), { db: { dataLakes, dataLakeAccessGrants } });

    expect(result.map(l => l.id)).toContain('handed-on');
    expect(dataLakes.findAccessible).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: [] })
    );
  });

  it('resolves the set even when the caller precomputed the grant reach', async () => {
    // `grantedLakeIds` says the caller already ran the GRANT-REACH query, which is a different
    // question - skipping supersession on it would leave the Slack list path leaking alone.
    const { dataLakes, dataLakeAccessGrants } = handedOnRepos([lake()]);

    await listDataLakes(ctx(), { db: { dataLakes, dataLakeAccessGrants }, grantedLakeIds: ['other'] });

    expect(dataLakes.findAccessible).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: ['handed-on'] })
    );
  });

  it('degrades to the static registry instead of 500ing when the supersession read throws', async () => {
    // The resolution sits INSIDE the try that guards `findAccessible`, because it reads the same
    // two collections: on a deployment that has neither, hoisting it out turns the documented
    // silent fall-through to the hardcoded registry into an unhandled throw at the route. Pinned
    // here because nothing else would go red if a later edit moved it back out.
    const { dataLakes, dataLakeAccessGrants } = handedOnRepos([lake()]);
    dataLakes.findIdsCreatedBy.mockRejectedValue(new Error('ns not found'));

    const result = await listDataLakes(ctx(), { db: { dataLakes, dataLakeAccessGrants } });

    expect(result.map(l => l.id)).not.toContain('handed-on');
    // Not merely "did not throw": the throw has to land before the row set is read, or a failed
    // narrowing would hand back the UNnarrowed rows - the exact leak this file exists to close.
    expect(dataLakes.findAccessible).not.toHaveBeenCalled();
  });

  it.each([
    ['archived', listArchivedDataLakes, 'archived'],
    ['deleted', listDeletedDataLakes, 'deleted'],
    ['transitional', listTransitionalDataLakes, 'archiving'],
  ] as const)('passes the exclusion on the %s management view too', async (_name, lister, status) => {
    const { dataLakes, dataLakeAccessGrants } = handedOnRepos([lake({ status })]);

    const result = await lister(ctx(), { db: { dataLakes, dataLakeAccessGrants } });

    expect(result).toEqual([]);
    expect(dataLakes.findAccessible).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ supersededOwnLakeIds: ['handed-on'] })
    );
  });
});
