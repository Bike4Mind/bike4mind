import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument, RecordLakeConfigChangeInput } from '@bike4mind/common';
import { updateDataLake } from './updateDataLake';
import { setLakeVisibility } from './setLakeVisibility';
import { transferLakeOwnership } from './transferLakeOwnership';
import { archiveDataLake } from './archiveDataLake';
import { deleteDataLake } from './deleteDataLake';
import { unarchiveDataLake } from './unarchiveDataLake';
import { restoreDeletedDataLake } from './restoreDeletedDataLake';
import { recomputeLakeStats } from './recomputeLakeStats';
import { removeFileFromDataLake } from './removeFileFromDataLake';

/**
 * The config-change event, from the SERVICE side: which write paths emit one, what they put in it,
 * and - the half that matters most - which writes emit nothing. The event's own persistence is
 * pinned in packages/database (LakeConfigChangeEventModel.test.ts), since every repository here is
 * a mock and a missing schema path would be invisible to these tests.
 */

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const owner = { userId: 'owner', isAdmin: false };

/** An event repo plus readers for what it was handed. */
const auditSpy = () => {
  const record = vi.fn().mockResolvedValue({});
  return {
    db: { lakeConfigChangeEvents: { record } },
    record,
    events: () => record.mock.calls.map(c => c[0] as RecordLakeConfigChangeInput),
    only: () => {
      expect(record).toHaveBeenCalledTimes(1);
      return record.mock.calls[0][0] as RecordLakeConfigChangeInput;
    },
  };
};

/** `update` echoing the merged document back, the way BaseModel.update does. */
const echoUpdate = (existing: IDataLakeDocument) =>
  vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...existing, ...d }));

const noGrants = { listByLake: vi.fn().mockResolvedValue([]) };

describe('updateDataLake', () => {
  it('records the fields that moved, attributed to the rung that authorized the write', async () => {
    const existing = lake({ description: 'old' });
    const audit = auditSpy();
    await updateDataLake(
      owner,
      'lake1',
      { description: 'new' },
      {
        db: {
          dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: echoUpdate(existing) },
          dataLakeAccessGrants: noGrants,
          ...audit.db,
        },
      }
    );

    expect(audit.only()).toMatchObject({
      dataLakeId: 'lake1',
      action: 'update',
      manageRung: 'creator',
      principalKind: 'user',
      principalId: 'owner',
      changes: [{ field: 'description', kind: 'literal', before: 'old', after: 'new' }],
    });
  });

  // The rung is left to resolveLakeManageRung on this path (as on archive/unarchive/delete/restore),
  // so a dual-role owner's routine rename recorded `platform-admin` too - the same false alarm as
  // the visibility rows, on every resolver-driven action.
  it('attributes a rename by an admin who owns the lake to their ownership', async () => {
    const existing = lake({ name: 'Lake' });
    const audit = auditSpy();
    await updateDataLake(
      { userId: 'owner', isAdmin: true },
      'lake1',
      { name: 'Renamed' },
      {
        db: {
          dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: echoUpdate(existing) },
          dataLakeAccessGrants: noGrants,
          ...audit.db,
        },
      }
    );

    expect(audit.only().manageRung).toBe('creator');
  });

  // A concurrent writer's change must never be attributed to THIS caller. `BaseModel.update` is a
  // `findOneAndUpdate` with `new: true`, so its result carries whatever else landed on the document
  // between our read and our write. Diffing that result would put another principal's field change
  // in our audit row, under our rung - an audit naming the wrong person, which is worse than a
  // missing one. The diff is therefore taken over the keys THIS caller supplied.
  it("records only the caller's own fields when a concurrent writer lands between read and write", async () => {
    const existing = lake({ description: 'old', name: 'Lake' });
    const audit = auditSpy();
    // Someone else renamed the lake in the gap; the driver returns their change too.
    const raced = vi
      .fn()
      .mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...existing, name: 'Renamed By Admin', ...d }));

    await updateDataLake(
      owner,
      'lake1',
      { description: 'new' },
      {
        db: {
          dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: raced },
          dataLakeAccessGrants: noGrants,
          ...audit.db,
        },
      }
    );

    const changes = audit.only().changes;
    expect(changes).toEqual([{ field: 'description', kind: 'literal', before: 'old', after: 'new' }]);
    expect(changes.some(c => c.field === 'name')).toBe(false);
  });

  // The carried-over finding from PR 1's review: setLakeVisibility has always early-returned on a
  // no-op, updateDataLake never did. Harmless for a stamp; wrong for an event, which would log a
  // change that did not happen.
  describe('no-op write', () => {
    it('does not write at all when every field already holds the value being set', async () => {
      const existing = lake({ name: 'Lake', description: 'same' });
      const update = echoUpdate(existing);
      const audit = auditSpy();
      const result = await updateDataLake(
        owner,
        'lake1',
        { name: 'Lake', description: 'same' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      expect(update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    // The no-op gate compares the NORMALIZED write, not the raw request: `requiredEntitlement` is
    // lowercased at write time because Mongo `$in` is case-sensitive, so `PRODUCT:PRO` onto a
    // stored `product:pro` is the same value and must not write. Comparing before normalizing
    // would write, move the actor stamp, and record a change that altered no access decision.
    it('treats a differently-cased entitlement as a no-op, since it normalizes to the stored value', async () => {
      const existing = lake({ requiredEntitlement: 'product:pro' });
      const update = echoUpdate(existing);
      const audit = auditSpy();
      const result = await updateDataLake(
        owner,
        'lake1',
        { requiredEntitlement: 'PRODUCT:PRO' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      expect(update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    // The WRITE gate is raw equality over the supplied keys; the AUDIT gate is the semantic diff.
    // Clearing an already-clear gate ('' onto unset) is a real difference to the document, so it
    // writes - but it moved no meaningful value, so it records nothing. Conflating the two is what
    // made a whitespace-only gate unclearable.
    it('writes but records nothing when clearing an already-clear gate', async () => {
      const existing = lake();
      const update = echoUpdate(existing);
      const audit = auditSpy();
      await updateDataLake(
        owner,
        'lake1',
        { requiredUserTag: '', requiredEntitlement: '' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });

    // The regression this separation exists to prevent. ' ' is accepted by the request schema and
    // is TRUTHY, so it really does gate the lake - but the audit diff trims it to "unset", exactly
    // like ''. When the diff was the write gate, the clearing PUT looked like a no-op and the lake
    // stayed gated to a tag nobody can hold, with no API path left to clear it.
    it('clears a whitespace-only gate instead of mistaking the clear for a no-op', async () => {
      const existing = lake({ requiredUserTag: ' ' });
      const update = echoUpdate(existing);
      const audit = auditSpy();
      await updateDataLake(
        owner,
        'lake1',
        { requiredUserTag: '' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toMatchObject({ requiredUserTag: '' });
    });

    it('persists a whitespace-only reformat of the system prompt rather than vetoing the write', async () => {
      const existing = lake({ systemPrompt: 'Answer briefly.' });
      const update = echoUpdate(existing);
      const audit = auditSpy();
      await updateDataLake(
        owner,
        'lake1',
        { systemPrompt: 'Answer briefly.\n' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      // The write lands (the stored text really did change)...
      expect(update).toHaveBeenCalledTimes(1);
      // ...but the fingerprint trims, so the history is not polluted by a whitespace edit.
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('still writes when ONE field of many actually moves', async () => {
      const existing = lake({ name: 'Lake', description: 'old' });
      const update = echoUpdate(existing);
      const audit = auditSpy();
      await updateDataLake(
        owner,
        'lake1',
        { name: 'Lake', description: 'new' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update },
            dataLakeAccessGrants: noGrants,
            ...audit.db,
          },
        }
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(audit.only().changes.map(c => c.field)).toEqual(['description']);
    });
  });

  it('never puts the system prompt in the event, only its fingerprint', async () => {
    const existing = lake({ systemPrompt: 'the old instructions' });
    const audit = auditSpy();
    await updateDataLake(
      owner,
      'lake1',
      { systemPrompt: 'Answer as the acquiring party' },
      {
        db: {
          dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: echoUpdate(existing) },
          dataLakeAccessGrants: noGrants,
          ...audit.db,
        },
      }
    );

    const event = audit.only();
    expect(JSON.stringify(event)).not.toContain('acquiring');
    expect(JSON.stringify(event)).not.toContain('old instructions');
    expect(event.changes[0]).toMatchObject({ field: 'systemPrompt', kind: 'fingerprint' });
  });

  it('does not fail the config write when the audit write throws', async () => {
    const existing = lake({ description: 'old' });
    const record = vi.fn().mockRejectedValue(new Error('mongo down'));
    const warn = vi.fn();
    await expect(
      updateDataLake(
        owner,
        'lake1',
        { description: 'new' },
        {
          db: {
            dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: echoUpdate(existing) },
            dataLakeAccessGrants: noGrants,
            lakeConfigChangeEvents: { record },
          },
          logger: { warn },
        }
      )
    ).resolves.toMatchObject({ description: 'new' });
    expect(warn).toHaveBeenCalled();
  });

  it('records nothing when no audit repo is wired, and still performs the write', async () => {
    const existing = lake({ description: 'old' });
    const update = echoUpdate(existing);
    await expect(
      updateDataLake(
        owner,
        'lake1',
        { description: 'new' },
        {
          db: { dataLakes: { findById: vi.fn().mockResolvedValue(existing), update }, dataLakeAccessGrants: noGrants },
        }
      )
    ).resolves.toMatchObject({ description: 'new' });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('setLakeVisibility', () => {
  it('records the scope move under the visibility action', async () => {
    const existing = lake();
    const audit = auditSpy();
    await setLakeVisibility({ ...owner, organizationId: 'org-1' }, 'lake1', 'organization', {
      db: {
        dataLakes: {
          findById: vi.fn().mockResolvedValue(existing),
          update: echoUpdate(existing),
          find: vi.fn().mockResolvedValue([]),
        },
        dataLakeAccessGrants: noGrants,
        ...audit.db,
      },
    });

    const event = audit.only();
    expect(event.action).toBe('visibility');
    expect(event.changes.map(c => c.field).sort()).toEqual(['organizationId']);
  });

  // P2: the exposing gate is deliberately isEffectiveOwner, WITHOUT the admin bypass - so when an
  // admin who is ALSO the owner exposes a lake, ownership is what let them through, not admin.
  // resolveLakeManageRung's first branch returns 'platform-admin' unconditionally, so without the
  // explicit override this records an authority that could not have passed this gate. Removing the
  // override makes this red.
  it('records ownership, not platform-admin, when an admin who owns the lake exposes it', async () => {
    const existing = lake();
    const audit = auditSpy();

    await setLakeVisibility({ userId: 'owner', isAdmin: true, organizationId: 'org-1' }, 'lake1', 'organization', {
      db: {
        dataLakes: {
          findById: vi.fn().mockResolvedValue(existing),
          update: echoUpdate(existing),
          find: vi.fn().mockResolvedValue([]),
        },
        dataLakeAccessGrants: noGrants,
        ...audit.db,
      },
    });

    expect(audit.only().manageRung).toBe('creator');
  });

  // Both directions of one owner's own edit must name the same authority: un-publishing recorded
  // `platform-admin` for a dual-role (platform admin + owner) account while publishing recorded
  // ownership, so the History tab flagged half of the same account's own visibility edits as an
  // outside intervention. Restoring the admin-first arm in resolveLakeManageRung makes this red.
  it('records ownership in BOTH directions when an admin who owns the lake publishes then un-publishes', async () => {
    const dualRole = { userId: 'owner', isAdmin: true, organizationId: 'org-1' };
    const published = lake({ isPublic: true });
    const audit = auditSpy();
    const db = (existing: IDataLakeDocument) => ({
      dataLakes: {
        findById: vi.fn().mockResolvedValue(existing),
        update: echoUpdate(existing),
        find: vi.fn().mockResolvedValue([]),
      },
      dataLakeAccessGrants: noGrants,
      ...audit.db,
    });

    await setLakeVisibility(dualRole, 'lake1', 'public', { db: db(lake()) });
    await setLakeVisibility(dualRole, 'lake1', 'private', { db: db(published) });

    expect(audit.events().map(e => e.manageRung)).toEqual(['creator', 'creator']);
  });

  // The other half of the same rule: an admin acting on a lake they have NO relationship to is
  // genuinely acting as admin, in either direction, and must still record that.
  it('still records platform-admin when an admin makes a lake private', async () => {
    const existing = lake({ isPublic: true });
    const audit = auditSpy();

    await setLakeVisibility({ userId: 'someAdmin', isAdmin: true }, 'lake1', 'private', {
      db: {
        dataLakes: {
          findById: vi.fn().mockResolvedValue(existing),
          update: echoUpdate(existing),
          find: vi.fn().mockResolvedValue([]),
        },
        dataLakeAccessGrants: noGrants,
        ...audit.db,
      },
    });

    expect(audit.only().manageRung).toBe('platform-admin');
  });

  it('records nothing on its pre-existing no-op early-return', async () => {
    const existing = lake({ isPublic: true });
    const update = vi.fn();
    const audit = auditSpy();
    await setLakeVisibility(owner, 'lake1', 'public', {
      db: {
        dataLakes: { findById: vi.fn().mockResolvedValue(existing), update, find: vi.fn().mockResolvedValue([]) },
        dataLakeAccessGrants: noGrants,
        ...audit.db,
      },
    });

    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('transferLakeOwnership', () => {
  const transferDb = (existing: IDataLakeDocument) => ({
    dataLakes: { findById: vi.fn().mockResolvedValue(existing), update: echoUpdate(existing) },
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]), upsertGrant: vi.fn().mockResolvedValue({}) },
    users: { findById: vi.fn().mockResolvedValue({ id: 'newOwner' }) },
    organizations: { findById: vi.fn() },
  });

  // Ownership lives in grant rows, so a document diff can never see it; the derived field is what
  // keeps a transfer an ordinary before -> after row instead of an action with nothing to show.
  it('records the ownership move on the derived field', async () => {
    const existing = lake();
    const audit = auditSpy();
    await transferLakeOwnership(owner, 'lake1', 'newOwner', { db: { ...transferDb(existing), ...audit.db } });

    expect(audit.only()).toMatchObject({
      action: 'transfer-ownership',
      changes: [{ field: 'effectiveOwnerUserId', kind: 'literal', before: 'owner', after: 'newOwner' }],
    });
  });

  // P3a: the override at transferLakeOwnership.ts:190-198 had no test that could tell it from the
  // plain resolver, because every existing case used an actor the two agree on. This is the case
  // they DISAGREE on, and it is the exact one the override's comment describes: an org admin who was
  // demoted to curator by a PRIOR transfer. resolveLakeManageRung checks the curator grant before
  // the org-admin rung, so it would label this succession `grant-curator` - a rung this gate
  // explicitly forbids from transferring. Deleting the override makes this test red.
  it('records the org-admin rung on a transfer by an org admin who also holds a curator grant', async () => {
    const existing = lake({ organizationId: 'org-1' });
    const audit = auditSpy();
    const db = transferDb(existing);
    db.dataLakeAccessGrants.listByLake = vi
      .fn()
      .mockResolvedValue([{ principalType: 'user', principalId: 'orgAdmin', role: 'curator', status: 'active' }]);
    // An org-owned lake requires the incoming owner to be a member of that org.
    db.organizations.findById = vi.fn().mockResolvedValue({ id: 'org-1', users: [{ userId: 'newOwner' }] });

    await transferLakeOwnership(
      { userId: 'orgAdmin', isAdmin: false, administeredOrgIds: ['org-1'] },
      'lake1',
      'newOwner',
      { db: { ...db, ...audit.db } }
    );

    expect(audit.only().manageRung).toBe('org-admin');
  });

  // Same false alarm as the visibility rows, through the other hand-written override: this gate's
  // own ternary checked actor.isAdmin FIRST, so a dual-role owner handing off their own lake was
  // recorded as a platform admin doing it to them. The two overrides now agree with the resolver.
  it('records ownership, not platform-admin, when an admin transfers a lake they own', async () => {
    const existing = lake();
    const audit = auditSpy();
    await transferLakeOwnership({ userId: 'owner', isAdmin: true }, 'lake1', 'newOwner', {
      db: { ...transferDb(existing), ...audit.db },
    });

    expect(audit.only().manageRung).toBe('creator');
  });

  it('records platform-admin when an admin transfers a lake they do NOT own', async () => {
    const existing = lake();
    const audit = auditSpy();
    await transferLakeOwnership({ userId: 'root', isAdmin: true }, 'lake1', 'newOwner', {
      db: { ...transferDb(existing), ...audit.db },
    });

    expect(audit.only().manageRung).toBe('platform-admin');
  });

  it('records nothing when the named owner already solely owns the lake', async () => {
    const existing = lake();
    const audit = auditSpy();
    await transferLakeOwnership(owner, 'lake1', 'owner', { db: { ...transferDb(existing), ...audit.db } });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('lifecycle services', () => {
  const lifecycleDb = (existing: IDataLakeDocument) => ({
    dataLakes: {
      findById: vi.fn().mockResolvedValue(existing),
      update: echoUpdate(existing),
      setStats: vi.fn(),
      activateIfDraft: vi.fn().mockResolvedValue(false),
      claimRestoring: vi.fn().mockResolvedValue(true),
      claimArchiving: vi.fn().mockResolvedValue(true),
      claimDeleting: vi.fn().mockResolvedValue(true),
      claimUnarchiving: vi.fn().mockResolvedValue(true),
      find: vi.fn().mockResolvedValue([]),
      claimFilesArchivedAt: vi.fn().mockResolvedValue(new Date()),
      claimFilesDeletedAt: vi.fn().mockResolvedValue(new Date()),
    },
    dataLakeAccessGrants: noGrants,
    batches: { findActiveByDataLakeId: vi.fn().mockResolvedValue([]), markTerminalIfActive: vi.fn() },
    fabFiles: {
      archiveByDataLakeTag: vi.fn().mockResolvedValue(0),
      softDeleteByDataLakeTag: vi.fn().mockResolvedValue(0),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
      findIdsByDataLakeTag: vi.fn().mockResolvedValue([]),
      hasArchivedMemberExclusiveToDataLakeTag: vi.fn().mockResolvedValue(false),
      findArchivedByDataLakeTag: vi.fn().mockResolvedValue([]),
      findDeletedByDataLakeTag: vi.fn().mockResolvedValue([]),
      findByContentHashesInDataLake: vi.fn().mockResolvedValue([]),
      unarchiveByDataLakeTag: vi.fn().mockResolvedValue(0),
      undeleteByDataLakeTag: vi.fn().mockResolvedValue(0),
      deleteManyInIds: vi.fn().mockResolvedValue(0),
    },
  });

  // The invariant PR 1 established and this must not break: lifecycle services act on the TERMINAL
  // hop only, never the transitional archiving/deleting/restoring one. One operator action, one
  // audit row - not two, and never one describing a transition the user did not ask for.
  it.each([
    ['archive', archiveDataLake, lake({ status: 'active' }), 'archive', 'archived'],
    ['delete', deleteDataLake, lake({ status: 'archived' }), 'delete', 'deleted'],
    ['unarchive', unarchiveDataLake, lake({ status: 'archived' }), 'unarchive', 'active'],
    ['restore', restoreDeletedDataLake, lake({ status: 'deleted' }), 'restore', 'active'],
  ])(
    '%s records exactly one event, for the terminal status only',
    async (_name, service, existing, action, terminal) => {
      const audit = auditSpy();
      await (service as (a: unknown, id: string, adapters: unknown) => Promise<unknown>)(owner, 'lake1', {
        db: { ...lifecycleDb(existing), ...audit.db },
      });

      const event = audit.only();
      expect(event.action).toBe(action);
      const statusChange = event.changes.find(c => c.field === 'status');
      expect(statusChange).toMatchObject({ before: existing.status, after: terminal });
    }
  );

  // The sibling half of the updateDataLake concurrent-writer case. These services have a LONG gap
  // between their `findById` and their terminal write (batch cancel, file sweep, index removal),
  // so a rename landing in it is more likely here, not less. Diffing the `findOneAndUpdate` result
  // would attribute that rename to whoever ran the lifecycle action, under their rung.
  it.each([
    ['archive', archiveDataLake, lake({ status: 'active' })],
    ['delete', deleteDataLake, lake({ status: 'active' })],
    ['unarchive', unarchiveDataLake, lake({ status: 'archived' })],
    ['restore', restoreDeletedDataLake, lake({ status: 'deleted' })],
  ] as const)(
    '%s records only its own status change when a concurrent rename lands mid-operation',
    async (_n, service, existing) => {
      const audit = auditSpy();
      const db = { ...lifecycleDb(existing), ...audit.db };
      db.dataLakes.update = vi
        .fn()
        .mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...existing, name: 'Renamed By Admin', ...d }));

      await service(owner, 'lake1', { db });

      const fields = audit.only().changes.map(c => c.field);
      expect(fields).toContain('status');
      expect(fields).not.toContain('name');
    }
  );

  it('records nothing when archive short-circuits on an already-archived lake', async () => {
    const existing = lake({ status: 'archived' });
    const audit = auditSpy();
    await archiveDataLake(owner, 'lake1', { db: { ...lifecycleDb(existing), ...audit.db } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  // The sibling of the archive case above. Each lifecycle service refuses a no-op differently -
  // delete returns the document silently, unarchive and restore throw - and only archive was pinned,
  // so dropping any of the other three guards would leave this suite green while a second audit row
  // appeared for an operator action that did not happen.
  it('records nothing when delete short-circuits on an already-deleted lake', async () => {
    const existing = lake({ status: 'deleted' });
    const audit = auditSpy();
    await expect(
      deleteDataLake(owner, 'lake1', { db: { ...lifecycleDb(existing), ...audit.db } })
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['unarchive', unarchiveDataLake, lake({ status: 'active' })],
    ['restore', restoreDeletedDataLake, lake({ status: 'active' })],
  ] as const)('%s records nothing when it rejects a lake in the wrong status', async (_n, service, existing) => {
    const audit = auditSpy();
    await expect(service(owner, 'lake1', { db: { ...lifecycleDb(existing), ...audit.db } })).rejects.toThrow(
      /Cannot restore a data lake/
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  // The lifecycle half of the updateDataLake swallow test above. The config write has already
  // landed by the time the recorder runs, so an audit failure must never turn a completed archive
  // into a reported failure - and each of these four reaches the recorder independently.
  it.each([
    ['archive', archiveDataLake, lake({ status: 'active' })],
    ['delete', deleteDataLake, lake({ status: 'archived' })],
    ['unarchive', unarchiveDataLake, lake({ status: 'archived' })],
    ['restore', restoreDeletedDataLake, lake({ status: 'deleted' })],
  ] as const)('%s does not fail the write when the audit write throws', async (_n, service, existing) => {
    const warn = vi.fn();
    const db = {
      ...lifecycleDb(existing),
      lakeConfigChangeEvents: { record: vi.fn().mockRejectedValue(new Error('mongo down')) },
    };

    await expect(service(owner, 'lake1', { db, logger: { warn } })).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  // Documents an ACCEPTED consequence rather than a defect, so a future reader does not "fix" it
  // silently: the transitional hop is deliberately unaudited, so a crash-retry that re-enters from
  // 'restoring' records `restoring -> active` and the original `archived` provenance is not
  // recoverable from the event. Auditing the hop instead would put two rows on one operator action.
  it('records the transitional status as `before` when unarchive re-enters from a crashed attempt', async () => {
    const existing = lake({ status: 'restoring' });
    const audit = auditSpy();

    await unarchiveDataLake(owner, 'lake1', { db: { ...lifecycleDb(existing), ...audit.db } });

    const statusChange = audit.only().changes.find(c => c.field === 'status');
    expect(statusChange).toMatchObject({ before: 'restoring', after: 'active' });
  });

  // The record call is placed BEFORE the stats recompute deliberately: the lake is already archived
  // by then, so a recompute failure must not also cost the audit row. Reordering the two is an easy
  // refactor to make by accident, and nothing else would go red.
  it('still records the archive when the stats recompute throws afterwards', async () => {
    const existing = lake({ status: 'active' });
    const audit = auditSpy();
    const db = { ...lifecycleDb(existing), ...audit.db };
    db.fabFiles.computeDataLakeStats = vi.fn().mockRejectedValue(new Error('stats down'));

    await expect(archiveDataLake(owner, 'lake1', { db })).rejects.toThrow(/stats down/);
    expect(audit.only()).toMatchObject({ action: 'archive' });
  });

  // The same ordering invariant on the OTHER lifecycle services. Previously only archive was
  // pinned, so a reorder in unarchive or restore would have gone unnoticed - the transition has
  // already landed at that point, so a recompute failure must never also cost the audit row.
  it.each([
    ['unarchive', unarchiveDataLake, lake({ status: 'archived' }), 'unarchive'],
    ['restore', restoreDeletedDataLake, lake({ status: 'deleted' }), 'restore'],
  ] as const)(
    'still records the %s when the stats recompute throws afterwards',
    async (_n, service, existing, action) => {
      const audit = auditSpy();
      const db = { ...lifecycleDb(existing), ...audit.db };
      db.fabFiles.computeDataLakeStats = vi.fn().mockRejectedValue(new Error('stats down'));

      await expect(service(owner, 'lake1', { db })).rejects.toThrow(/stats down/);
      expect(audit.only()).toMatchObject({ action });
    }
  );

  // BaseModel.update is a findOneAndUpdate that RESOLVES null when the lake vanished mid-operation.
  // Without the guard, diffLakeConfig(existing, null) throws and turns a previously-succeeding
  // unarchive/restore into a 500 - a regression introduced purely by adding the audit call.
  it.each([
    ['unarchive', unarchiveDataLake, lake({ status: 'archived' })],
    ['restore', restoreDeletedDataLake, lake({ status: 'deleted' })],
  ])('%s survives the lake vanishing mid-operation and records nothing', async (_name, service, existing) => {
    const audit = auditSpy();
    const db = { ...lifecycleDb(existing), ...audit.db };
    db.dataLakes.update = vi.fn().mockResolvedValue(null);

    await expect(
      (service as (a: unknown, id: string, adapters: unknown) => Promise<unknown>)(owner, 'lake1', { db })
    ).resolves.toBeDefined();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('recomputeLakeStats - the unattributed draft -> active flip', () => {
  const statsDb = (activated: boolean) => ({
    dataLakes: { setStats: vi.fn(), activateIfDraft: vi.fn().mockResolvedValue(activated) },
    fabFiles: {
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSizeBytes: 10, totalChunkedChars: 5 }),
    },
  });

  it('records the status move when activateIfDraft actually flipped the lake', async () => {
    const audit = auditSpy();
    await recomputeLakeStats(lake({ status: 'draft' }), { db: { ...statsDb(true), ...audit.db } });
    expect(audit.only()).toMatchObject({
      action: 'auto-activate',
      // Nothing AUTHORIZED this - activateIfDraft runs no authorization check at all - so the rung
      // is `system` even though a lake creator is sitting right there on the document.
      manageRung: 'system',
      principalKind: 'system',
      changes: [{ field: 'status', kind: 'literal', before: 'draft', after: 'active' }],
    });
  });

  // Every recompute on an already-active lake calls activateIfDraft, so recording unconditionally
  // would put a status row in the history on every single file upload.
  it('records nothing when the lake was already active', async () => {
    const audit = auditSpy();
    await recomputeLakeStats(lake(), { db: { ...statsDb(false), ...audit.db } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records nothing when activation was skipped entirely', async () => {
    const audit = auditSpy();
    const db = { ...statsDb(true), ...audit.db };
    await recomputeLakeStats(lake(), { db }, { skipActivation: true });
    expect(db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('names the actor as principal when a caller threaded one, while the rung stays system', async () => {
    const audit = auditSpy();
    await recomputeLakeStats(lake({ status: 'draft' }), { db: { ...statsDb(true), ...audit.db } }, { actor: owner });
    expect(audit.only()).toMatchObject({ principalKind: 'user', principalId: 'owner', manageRung: 'system' });
  });

  // activateIfDraft matches `status: { $in: ['draft', null] }`, so it also flips a lake written
  // before the field existed. Asserting `before: 'draft'` for one of those would put a value in the
  // audit that was never on the document - an absent `before` reads as "unset", which is the truth.
  it('does not invent a prior status for a legacy lake whose status was never set', async () => {
    const audit = auditSpy();
    const legacy = lake();
    delete (legacy as { status?: string }).status;
    await recomputeLakeStats(legacy, { db: { ...statsDb(true), ...audit.db } });

    const [change] = audit.only().changes;
    expect(change).toMatchObject({ field: 'status', after: 'active' });
    expect('before' in change).toBe(false);
  });
});
/**
 * The FOURTH `recomputeLakeStats` call site. The audit-loss-logging fix originally reached
 * archive/unarchive/restore and stopped there, which is the same fix-completeness miss this series
 * has hit before: the bug is not in the call that was fixed, it is in the siblings nobody swept.
 *
 * This one is not mere parity either - removing a file still runs `activateIfDraft`, so it really
 * can emit an `auto-activate` row, and an audit-write failure here without a logger falls all the
 * way through to a bare console.error that no alert is keyed on.
 */
describe('removeFileFromDataLake - audit-loss logging on the stats recompute', () => {
  const removeDb = (audit: ReturnType<typeof auditSpy>) => ({
    dataLakes: {
      findById: vi.fn().mockResolvedValue(lake({ status: 'draft' })),
      setStats: vi.fn(),
      activateIfDraft: vi.fn().mockResolvedValue(true),
    },
    fabFiles: {
      // tags are {name} objects, and userId must equal the LAKE'S creator - removeFileFromLake
      // anchors membership on the lake's owner, not on the acting user.
      findById: vi.fn().mockResolvedValue({ id: 'f1', tags: [{ name: 'datalake:lake' }], userId: 'owner' }),
      pullTagsByFabFileId: vi.fn().mockResolvedValue(undefined),
      // Non-zero on purpose: recomputeLakeStats only reaches activateIfDraft when files REMAIN,
      // so a lake emptied by the removal would never exercise the audit path this pins.
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 2, totalSizeBytes: 10, totalChunkedChars: 5 }),
    },
    dataLakeAccessGrants: noGrants,
    ...audit.db,
  });

  it('forwards its logger, so a failed audit write is reported at error rather than swallowed', async () => {
    const audit = auditSpy();
    audit.record.mockRejectedValueOnce(new Error('mongo is down'));
    const error = vi.fn();

    await removeFileFromDataLake(owner, 'lake1', 'f1', { db: removeDb(audit), logger: { error } });

    // The write still succeeds - audit loss must never fail the user's action - but it is now LOUD.
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  /**
   * The actor is threaded, not dropped: `removeFileFromDataLake` already holds one for the
   * membership write, so an `auto-activate` row it emits must name that person. The rung stays
   * `system` - `activateIfDraft` authorizes nothing.
   */
  it('names the removing actor as the principal on the auto-activate row it emits', async () => {
    const audit = auditSpy();
    await removeFileFromDataLake(owner, 'lake1', 'f1', { db: removeDb(audit) });
    expect(audit.only()).toMatchObject({
      action: 'auto-activate',
      principalKind: 'user',
      principalId: 'owner',
      manageRung: 'system',
    });
  });

  it('carries an actor auditPrincipal through, so a key-driven removal names the KEY', async () => {
    const audit = auditSpy();
    await removeFileFromDataLake(
      { ...owner, auditPrincipal: { principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: 'owner' } },
      'lake1',
      'f1',
      { db: removeDb(audit) }
    );
    expect(audit.only()).toMatchObject({
      principalKind: 'apiKey',
      principalId: 'key-abc',
      onBehalfOfUserId: 'owner',
    });
  });

  it('still completes the removal when no logger is wired at all', async () => {
    // The adapter field is optional, so a caller that has not threaded one must not crash.
    const audit = auditSpy();
    await expect(removeFileFromDataLake(owner, 'lake1', 'f1', { db: removeDb(audit) })).resolves.toMatchObject({
      success: true,
    });
  });
});
