import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { getDynamicDataLakeAccess, type DataLakeAccessContext } from './getDynamicDataLakeTags';

/**
 * RETRIEVAL is the path that reaches file CONTENT, and its creator arm is the same bare provenance
 * `findAccessible`'s owner arm was: `createdByUserId` is immutable, so a creator transferred or
 * departed off a lake keeps grounding chat answers on it after browse has stopped listing it.
 *
 * The query arm itself is pinned against real Mongo (DataLakeModel.ownerSupersession.test.ts). What
 * is pinned HERE is the half a query-only fix would have missed: this resolver re-derives ownership
 * IN MEMORY (`ownedDynamicIds`) and uses it to RESTORE a gated lake that the pure tag/entitlement
 * predicate dropped. Narrowing only the query would leave that restoration re-admitting exactly the
 * gated lakes the narrowing exists to withhold - so every test below deliberately mocks the repo as
 * OVER-RETURNING (it ignores the exclusion it is handed), which isolates the in-memory rule.
 */

const GATED = 'ATagIDoNotHold';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'mine',
    slug: 'mine',
    name: 'Mine',
    fileTagPrefix: 'mine:',
    datalakeTag: 'datalake:mine',
    createdByUserId: 'alice',
    status: 'active',
    requiredUserTag: GATED,
    ...overrides,
  }) as IDataLakeDocument;

/** `ownerOfMine` is whoever holds the active owner-role grant - alice unless a test says otherwise. */
const ctx = (lakes: IDataLakeDocument[], ownerOfMine: string) => {
  const findActiveByUserTagsAndEntitlements = vi.fn().mockResolvedValue(lakes);
  const context = {
    db: {
      dataLakes: {
        findActiveByUserTagsAndEntitlements,
        findIdsCreatedBy: vi.fn().mockResolvedValue(['mine']),
      },
      organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
      dataLakeAccessGrants: {
        listByPrincipal: vi.fn().mockResolvedValue([]),
        listActiveByLakes: vi
          .fn()
          .mockResolvedValue([{ dataLakeId: 'mine', principalType: 'user', principalId: ownerOfMine, role: 'owner' }]),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(false) },
    },
    user: { id: 'alice', tags: [] },
  } as unknown as DataLakeAccessContext;
  return { context, findActiveByUserTagsAndEntitlements };
};

describe('retrieval scope - a creator superseded as owner stops grounding on the lake', () => {
  it('drops the gated lake it would otherwise restore, even though the repo still returned it', async () => {
    const { context } = ctx([lake()], 'billing-owner');

    const res = await getDynamicDataLakeAccess(context);

    expect(res.dataLakeTags).toEqual([]);
    expect(res.scopedTagPrefixes).toEqual([]);
  });

  it('keeps restoring it while the caller is still the effective owner', async () => {
    // The same fixture with the owner grant left on alice. Without this the test above would pass
    // for a resolver that had simply stopped restoring owned gated lakes at all.
    const { context } = ctx([lake()], 'alice');

    const res = await getDynamicDataLakeAccess(context);

    expect(res.dataLakeTags).toEqual(['datalake:mine']);
    expect(res.scopedTagPrefixes).toEqual(['mine:']);
  });

  it('hands the exclusion to the datastore pre-filter, not only to the in-memory pass', async () => {
    const { context, findActiveByUserTagsAndEntitlements } = ctx([lake()], 'billing-owner');

    await getDynamicDataLakeAccess(context);

    expect(findActiveByUserTagsAndEntitlements).toHaveBeenCalledWith(
      [],
      [],
      [],
      'alice',
      expect.objectContaining({ supersededOwnLakeIds: ['mine'] })
    );
  });

  it('still admits a superseded lake the caller holds the GATE for - the narrowing is ownership only', async () => {
    // The restoration is what supersession closes; the ordinary tag predicate is untouched, so a
    // former owner who happens to hold the lake's tag keeps grounding on it like any other holder.
    const { context } = ctx([lake()], 'billing-owner');
    context.user.tags = [GATED];

    const res = await getDynamicDataLakeAccess(context);

    expect(res.dataLakeTags).toEqual(['datalake:mine']);
  });

  it('degrades OPEN and leaves lakeViewComplete alone when the supersession read throws', async () => {
    // Deliberately unlike the grant read beside it. A failed supersession read widens the view, so
    // reporting it as `lakeViewComplete: false` would tell consumers lakes may be MISSING - the
    // opposite of what happened, and the flag they use to refuse an unreachability verdict.
    const { context } = ctx([lake()], 'billing-owner');
    (context.db.dataLakes!.findIdsCreatedBy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ns not found'));

    const res = await getDynamicDataLakeAccess(context);

    expect(res.dataLakeTags).toEqual(['datalake:mine']);
    expect(res.lakeViewComplete).toBe(true);
  });

  it('resolves the exclusion on BOTH sides of the read-grant cutover', async () => {
    // An owner-role grant is what MOVES ownership, so it has to be honored whether or not reader
    // grants are being enforced. Gating this on the flag would leave retrieval leaking until cutover.
    const { context } = ctx([lake()], 'billing-owner');
    (context.db.adminSettings!.getSettingsValue as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const res = await getDynamicDataLakeAccess(context);

    expect(res.dataLakeTags).toEqual([]);
  });
});
