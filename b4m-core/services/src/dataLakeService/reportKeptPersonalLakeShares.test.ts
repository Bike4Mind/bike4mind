import { describe, expect, it, vi } from 'vitest';
import type { IDataLakeAccessGrantDocument, IDataLakeDocument } from '@bike4mind/common';
import { reportKeptPersonalLakeShares } from './reportKeptPersonalLakeShares';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const DEPARTED = 'departedUser';
const NO_KEPT_SHARES = { lakeCount: 0, byOwner: [] };

// Real 24-hex ids: production `dataLakeId` values are ObjectId strings, and DataLakeModel.findByIds
// guards on that shape internally.
const hexId = (n: number) => n.toString(16).padStart(24, '0');

const grant = (
  dataLakeId: string,
  role: IDataLakeAccessGrantDocument['role'],
  principalId = DEPARTED,
  over: Partial<IDataLakeAccessGrantDocument> = {}
) =>
  ({
    dataLakeId,
    principalType: 'user',
    principalId,
    role,
    grantedByUserId: 'granter',
    expiresAt: null,
    ...over,
  }) as IDataLakeAccessGrantDocument;

const personal = (id: string, createdByUserId: string, over: Partial<IDataLakeDocument> = {}) =>
  ({ id, name: `Lake ${id}`, createdByUserId, ...over }) as IDataLakeDocument;

const harness = (opts: {
  held?: IDataLakeAccessGrantDocument[];
  lakes?: IDataLakeDocument[];
  activeGrants?: IDataLakeAccessGrantDocument[];
}) => {
  const listByPrincipal = vi.fn().mockResolvedValue(opts.held ?? []);
  const findByIds = vi.fn().mockResolvedValue(opts.lakes ?? []);
  const listActiveByLakes = vi
    .fn()
    .mockImplementation(async (ids: string[]) => (opts.activeGrants ?? []).filter(g => ids.includes(g.dataLakeId)));
  return {
    listByPrincipal,
    findByIds,
    listActiveByLakes,
    adapters: { db: { dataLakes: { findByIds }, dataLakeAccessGrants: { listByPrincipal, listActiveByLakes } } },
  };
};

const run = (h: ReturnType<typeof harness>, departed = DEPARTED) =>
  reportKeptPersonalLakeShares(departed, h.adapters, NOW);

describe('reportKeptPersonalLakeShares', () => {
  it('reports a held grant on a personal lake, grouped under its owner', async () => {
    const mine = hexId(1);
    const h = harness({ held: [grant(mine, 'reader')], lakes: [personal(mine, 'alice')] });

    await expect(run(h)).resolves.toEqual({
      lakeCount: 1,
      byOwner: [{ ownerUserId: 'alice', lakes: [{ id: mine, name: `Lake ${mine}` }] }],
    });
    expect(h.listByPrincipal).toHaveBeenCalledWith('user', DEPARTED, { activeAsOf: NOW });
  });

  it('does not report a lake that belongs to an organization', async () => {
    const foreign = hexId(2);
    const h = harness({
      held: [grant(foreign, 'curator')],
      lakes: [personal(foreign, 'alice', { organizationId: 'someOrg' })],
    });

    await expect(run(h)).resolves.toEqual(NO_KEPT_SHARES);
  });

  it('groups lakes per effective owner, an owner grant superseding the creator', async () => {
    const [p1, p2, p3] = [hexId(3), hexId(4), hexId(5)];
    const h = harness({
      held: [grant(p1, 'reader'), grant(p2, 'reader'), grant(p3, 'curator')],
      lakes: [personal(p1, 'alice'), personal(p2, 'alice'), personal(p3, 'creatorGone')],
      activeGrants: [grant(p3, 'owner', 'bob')],
    });

    const result = await run(h);

    expect(result.lakeCount).toBe(3);
    expect(result.byOwner).toEqual([
      {
        ownerUserId: 'alice',
        lakes: [
          { id: p1, name: `Lake ${p1}` },
          { id: p2, name: `Lake ${p2}` },
        ],
      },
      { ownerUserId: 'bob', lakes: [{ id: p3, name: `Lake ${p3}` }] },
    ]);
  });

  it('reports a personal lake with two owner grants under BOTH owners, counted once', async () => {
    const shared = hexId(6);
    const h = harness({
      held: [grant(shared, 'reader')],
      lakes: [personal(shared, 'someoneElse')],
      activeGrants: [grant(shared, 'owner', 'carol'), grant(shared, 'owner', 'dave')],
    });

    await expect(run(h)).resolves.toEqual({
      lakeCount: 1,
      byOwner: [
        { ownerUserId: 'carol', lakes: [{ id: shared, name: `Lake ${shared}` }] },
        { ownerUserId: 'dave', lakes: [{ id: shared, name: `Lake ${shared}` }] },
      ],
    });
  });

  it('skips a lake the departing member owns, and a lake that is going away', async () => {
    const [own, gone] = [hexId(7), hexId(8)];
    const h = harness({
      held: [grant(own, 'owner'), grant(gone, 'reader')],
      lakes: [personal(own, 'alice'), personal(gone, 'alice', { status: 'deleted' })],
      activeGrants: [grant(own, 'owner')],
    });

    await expect(run(h)).resolves.toEqual(NO_KEPT_SHARES);
  });

  it('does no lookup when the departing member holds no grants at all', async () => {
    const h = harness({ held: [] });

    await expect(run(h)).resolves.toEqual(NO_KEPT_SHARES);
    expect(h.findByIds).not.toHaveBeenCalled();
    expect(h.listActiveByLakes).not.toHaveBeenCalled();
  });
});
