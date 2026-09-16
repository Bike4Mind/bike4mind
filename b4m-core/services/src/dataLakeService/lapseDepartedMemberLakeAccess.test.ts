import { describe, expect, it, vi } from 'vitest';
import type { IDataLakeAccessGrantDocument, IDataLakeDocument } from '@bike4mind/common';
import { lapseDepartedMemberLakeAccess } from './lapseDepartedMemberLakeAccess';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const DEPARTED = 'departedUser';
const BILLING_OWNER = 'billingOwner';
const ORG = { id: 'orgLeaving', userId: BILLING_OWNER };
const TRIGGER = { userId: 'removingAdmin' };

const lake = (id: string, createdByUserId = 'someoneElse') =>
  ({ id, organizationId: ORG.id, createdByUserId }) as IDataLakeDocument;

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

const harness = (opts: {
  lakes?: IDataLakeDocument[];
  held?: IDataLakeAccessGrantDocument[];
  activeOnCreated?: IDataLakeAccessGrantDocument[];
}) => {
  const findByOrganizationId = vi.fn().mockResolvedValue(opts.lakes ?? []);
  const listByPrincipal = vi.fn().mockResolvedValue(opts.held ?? []);
  const listActiveByLakes = vi.fn().mockResolvedValue(opts.activeOnCreated ?? []);
  const upsertGrant = vi.fn().mockImplementation(async (input: unknown) => input);
  const record = vi.fn().mockResolvedValue(undefined);
  // Resolves a document by default: `update` is a findOneAndUpdate, and a `null` here means the
  // lake vanished - a case one test below asserts on deliberately.
  const update = vi.fn().mockImplementation(async (input: { id: string }) => ({ id: input.id }));
  const warn = vi.fn();
  const adapters = {
    db: {
      dataLakes: { findByOrganizationId, update },
      dataLakeAccessGrants: { listByPrincipal, listActiveByLakes, upsertGrant },
      lakeConfigChangeEvents: { record },
    },
    logger: { warn },
  };
  return { findByOrganizationId, listByPrincipal, listActiveByLakes, upsertGrant, record, update, warn, adapters };
};

const run = (h: ReturnType<typeof harness>, departed = DEPARTED) =>
  lapseDepartedMemberLakeAccess(departed, ORG, TRIGGER, h.adapters, NOW);

const eventsFor = (h: ReturnType<typeof harness>, action: string) =>
  h.record.mock.calls.map(([event]) => event as { action: string }).filter(event => event.action === action);

describe('lapseDepartedMemberLakeAccess - phase 1, grants held by the departing member', () => {
  it('lapses a grant on a lake of the org being left, stamping the departure instant', async () => {
    const h = harness({ lakes: [lake('lakeA')], held: [grant('lakeA', 'reader')] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: ['lakeA'], succeededLakeIds: [] });
    expect(h.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: 'lakeA', principalId: DEPARTED, role: 'reader', expiresAt: NOW })
    );
  });

  it('asks only for USER-principal grants, so an organization grant is never swept', async () => {
    const h = harness({ lakes: [lake('lakeA')] });
    await run(h);
    expect(h.listByPrincipal).toHaveBeenCalledWith('user', DEPARTED, { activeAsOf: NOW });
  });

  it('leaves a grant on a lake of ANOTHER org untouched - the deliberate cross-org grant', async () => {
    // The departing member curates a lake belonging to an org they are not leaving. A grant holder
    // need not be a member of the lake's org, so departing THIS org must not reach it.
    const h = harness({ lakes: [lake('lakeA')], held: [grant('foreignLake', 'curator')] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: [] });
    expect(h.upsertGrant).not.toHaveBeenCalled();
  });

  it('DOES lapse an owner grant, unlike the manual revoke door', async () => {
    // revokeLakeAccess refuses an owner grant outright (dropping one there would un-transfer the
    // lake through a door that never named a new owner). On departure, leaving it is the bug.
    const h = harness({ lakes: [lake('lakeA')], held: [grant('lakeA', 'owner')] });

    await expect(run(h)).resolves.toMatchObject({ lapsedLakeIds: ['lakeA'] });
    expect(h.upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ role: 'owner', expiresAt: NOW }));
  });

  it('lapses every held grant across several lakes of the org', async () => {
    const h = harness({
      lakes: [lake('lakeA'), lake('lakeB')],
      held: [grant('lakeA', 'curator'), grant('lakeB', 'reader'), grant('foreignLake', 'reader')],
    });

    await expect(run(h)).resolves.toMatchObject({ lapsedLakeIds: ['lakeA', 'lakeB'] });
    expect(h.upsertGrant).toHaveBeenCalledTimes(2);
  });

  it('does no grant work at all when the org owns no lakes', async () => {
    const h = harness({ lakes: [] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: [] });
    expect(h.listByPrincipal).not.toHaveBeenCalled();
    expect(h.listActiveByLakes).not.toHaveBeenCalled();
  });

  it('is a no-op on a retry, because the row it expired is no longer live', async () => {
    // What the second pass of a withTransaction retry sees: listByPrincipal filters on activeAsOf,
    // so the just-expired row does not come back and nothing is re-stamped or re-audited.
    const h = harness({ lakes: [lake('lakeA')], held: [] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: [] });
    expect(h.upsertGrant).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('records the lapse as a system-rung revoke-access event naming the triggering principal', async () => {
    const h = harness({ lakes: [lake('lakeA')], held: [grant('lakeA', 'curator')] });

    await run(h);

    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'revoke-access',
        // No lake-side rung authorized this - an org membership change drove it.
        manageRung: 'system',
        principalKind: 'user',
        principalId: TRIGGER.userId,
        dataLakeId: 'lakeA',
        organizationId: ORG.id,
      })
    );
  });

  it('carries the role on both sides of the audit diff, so the row reads as a lapse not a delete', async () => {
    const h = harness({ lakes: [lake('lakeA')], held: [grant('lakeA', 'curator')] });

    await run(h);

    const [event] = eventsFor(h, 'revoke-access') as [{ changes: { before?: string; after?: string }[] }];
    expect(event.changes).toHaveLength(1);
    expect(event.changes[0].before).toBe(`user:${DEPARTED}=curator`);
    expect(event.changes[0].after).toBe(`user:${DEPARTED}=curator until ${NOW.toISOString()}`);
  });
});

describe('lapseDepartedMemberLakeAccess - phase 2, a lake the member created', () => {
  it('passes ownership to the billing owner when the creator leaves - the reproduced scenario', async () => {
    // Olivia creates an org lake (createDataLake seeds her an owner grant) and is then removed.
    // Lapsing her grant alone would drop her into resolveEffectiveOwnerIds' creator fallback and
    // re-admit her as effective owner, so succession is what actually closes the hole.
    const h = harness({
      lakes: [lake('lakeA', DEPARTED)],
      held: [grant('lakeA', 'owner')],
      activeOnCreated: [grant('lakeA', 'owner')],
    });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: ['lakeA'], succeededLakeIds: ['lakeA'] });
    expect(h.upsertGrant).toHaveBeenCalledWith({
      dataLakeId: 'lakeA',
      principalType: 'user',
      principalId: BILLING_OWNER,
      role: 'owner',
      grantedByUserId: TRIGGER.userId,
      expiresAt: null,
    });
  });

  it('succeeds even when the creator held NO grant at all', async () => {
    // The case an early "member holds no grants, return" shortcut would have missed entirely: the
    // creator fallback needs no row to admit them.
    const h = harness({ lakes: [lake('lakeA', DEPARTED)], held: [] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: ['lakeA'] });
    expect(h.upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: BILLING_OWNER }));
  });

  it('does not succeed when somebody else already holds an active owner grant', async () => {
    const h = harness({
      lakes: [lake('lakeA', DEPARTED)],
      held: [grant('lakeA', 'curator')],
      activeOnCreated: [grant('lakeA', 'owner', 'presentOwner')],
    });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: ['lakeA'], succeededLakeIds: [] });
    expect(h.upsertGrant).toHaveBeenCalledTimes(1); // the lapse only
  });

  it('ignores the DEPARTING member own owner row when deciding whether an owner remains', async () => {
    // Proves the decision does not rest on phase 1's write being visible to this read: the stub
    // still reports the departed member's owner grant as active, and succession fires regardless.
    const h = harness({
      lakes: [lake('lakeA', DEPARTED)],
      held: [grant('lakeA', 'owner')],
      activeOnCreated: [grant('lakeA', 'owner')],
    });

    await expect(run(h)).resolves.toMatchObject({ succeededLakeIds: ['lakeA'] });
  });

  it('skips succession when the departing member IS the billing owner', async () => {
    // revokeAccess drops them from users[] without clearing organization.userId, so they remain the
    // org's owner - succeeding to themselves would be a no-op that merely logged.
    const h = harness({ lakes: [lake('lakeA', BILLING_OWNER)], held: [grant('lakeA', 'owner', BILLING_OWNER)] });

    await expect(run(h, BILLING_OWNER)).resolves.toMatchObject({ succeededLakeIds: [] });
    expect(h.listActiveByLakes).not.toHaveBeenCalled();
  });

  it('asks nothing further when the member created none of the lakes of the org', async () => {
    const h = harness({ lakes: [lake('lakeA', 'someoneElse')], held: [grant('lakeA', 'reader')] });

    await expect(run(h)).resolves.toMatchObject({ succeededLakeIds: [] });
    expect(h.listActiveByLakes).not.toHaveBeenCalled();
  });

  it('scopes the grant re-read to the created lakes only, not the whole org', async () => {
    const h = harness({ lakes: [lake('lakeA', DEPARTED), lake('lakeB', 'someoneElse')] });

    await run(h);
    expect(h.listActiveByLakes).toHaveBeenCalledWith(['lakeA'], { activeAsOf: NOW });
  });

  it('records succession under its own action, so it is not mistaken for a deliberate transfer', async () => {
    const h = harness({ lakes: [lake('lakeA', DEPARTED)] });

    await run(h);

    const [event] = eventsFor(h, 'membership-succession') as [
      { manageRung: string; changes: { field: string; before?: string; after?: string }[] },
    ];
    expect(event.manageRung).toBe('system');
    expect(event.changes).toEqual([
      expect.objectContaining({ field: 'effectiveOwnerUserId', before: DEPARTED, after: BILLING_OWNER }),
    ]);
  });

  it('still succeeds when the only owner grant is an ORGANIZATION principal', async () => {
    // resolveEffectiveOwnerIds counts only USER owner grants, so an org-principal owner grant does
    // not supersede the creator - without succession the lake would still resolve to the departed
    // member. The guard has to agree with that rule, not with "an owner row exists".
    const h = harness({
      lakes: [lake('lakeA', DEPARTED)],
      activeOnCreated: [grant('lakeA', 'owner', 'someOrgId', { principalType: 'organization' })],
    });

    await expect(run(h)).resolves.toMatchObject({ succeededLakeIds: ['lakeA'] });
  });

  it('still succeeds when an owner grant carries no principalId', async () => {
    // Same lockstep, other direction: resolveEffectiveOwnerIds drops a principal-less owner row, so
    // it must not be read here as "somebody else already owns this" and skip the succession.
    const h = harness({
      lakes: [lake('lakeA', DEPARTED)],
      activeOnCreated: [grant('lakeA', 'owner', '')],
    });

    await expect(run(h)).resolves.toMatchObject({ succeededLakeIds: ['lakeA'] });
  });

  it('lapses but does not succeed on a lake somebody else created - the documented residue', async () => {
    // The departing member holds the owner grant on a lake another user created. Ownership falls
    // back to that creator, who may themselves have departed in an earlier untriggered removal.
    // Those pre-existing orphans need a backfill; this path creates none.
    const h = harness({ lakes: [lake('lakeA', 'earlierCreator')], held: [grant('lakeA', 'owner')] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: ['lakeA'], succeededLakeIds: [] });
    expect(eventsFor(h, 'membership-succession')).toHaveLength(0);
  });
});

describe('lapseDepartedMemberLakeAccess - the succession actor stamp', () => {
  // Ownership lives in the grants, so without this write the lake document is byte-identical after a
  // change of owner and keeps naming whoever made the last ordinary edit. It is also the write that
  // makes the lake document shared with `transferLakeOwnership`, which is what lets a transaction
  // detect the two colliding - so a regression here is a concurrency regression, not just a cosmetic
  // one.
  it('stamps the triggering principal on a lake whose ownership passed on', async () => {
    const h = harness({ lakes: [lake('lakeA', DEPARTED)] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: ['lakeA'] });

    expect(h.update).toHaveBeenCalledWith({ id: 'lakeA', lastUpdatedByUserId: TRIGGER.userId });
  });

  it('stamps AFTER the successor grant lands, so it never claims a succession that failed', async () => {
    const h = harness({ lakes: [lake('lakeA', DEPARTED)] });
    h.upsertGrant.mockRejectedValueOnce(new Error('grant write failed'));

    await expect(run(h)).rejects.toThrow('grant write failed');

    expect(h.update).not.toHaveBeenCalled();
  });

  it('does NOT stamp an ordinary lapse - that changes who can reach the lake, not its configuration', async () => {
    const h = harness({ lakes: [lake('lakeA')], held: [grant('lakeA', 'curator')] });

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: ['lakeA'], succeededLakeIds: [] });

    expect(h.update).not.toHaveBeenCalled();
  });

  it('warns rather than throws when the lake is gone, so the departure still commits', async () => {
    const h = harness({ lakes: [lake('lakeA', DEPARTED)] });
    h.update.mockResolvedValue(null);

    await expect(run(h)).resolves.toEqual({ lapsedLakeIds: [], succeededLakeIds: ['lakeA'] });

    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('not found for the actor stamp'), {
      dataLakeId: 'lakeA',
    });
  });
});
