import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { NewAdminAuditEntry } from '@bike4mind/common';
import {
  AdminAuditLogModel,
  adminAuditLogRepository,
  SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES,
} from '../models/infra/admin/AdminAuditLogModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await AdminAuditLogModel.syncIndexes();
});

const buildEntry = (overrides: Partial<NewAdminAuditEntry> = {}): NewAdminAuditEntry => ({
  occurredAt: new Date('2026-10-19T00:00:00Z'),
  action: 'credits.adjusted',
  category: 'credits',
  severity: 'notice',
  actor: { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Admin', wasAdmin: true },
  target: { kind: 'user', id: 'user-1', displayName: 'User One' },
  summary: 'Adjusted credits',
  context: { source: 'admin_ui' },
  ...overrides,
});

describe('AdminAuditLogModel', () => {
  it('append returns an entry with id and source admin', async () => {
    const entry = await adminAuditLogRepository.append(buildEntry());

    expect(entry.id).toMatch(/^[a-f0-9]{24}$/);
    expect(entry.source).toBe('admin');
    expect(entry.action).toBe('credits.adjusted');
    expect(entry.occurredAt).toEqual(new Date('2026-10-19T00:00:00Z'));
  });

  const immutableOperations: Array<[string, () => Promise<unknown>]> = [
    ['updateOne', () => AdminAuditLogModel.updateOne({}, { summary: 'x' })],
    ['updateMany', () => AdminAuditLogModel.updateMany({}, { summary: 'x' })],
    ['findOneAndUpdate', () => AdminAuditLogModel.findOneAndUpdate({}, { summary: 'x' })],
    ['replaceOne', () => AdminAuditLogModel.replaceOne({}, buildEntry())],
    ['findOneAndReplace', () => AdminAuditLogModel.findOneAndReplace({}, buildEntry())],
    ['deleteOne', () => AdminAuditLogModel.deleteOne({})],
    ['deleteMany', () => AdminAuditLogModel.deleteMany({})],
    ['findOneAndDelete', () => AdminAuditLogModel.findOneAndDelete({})],
    [
      'bulkWrite updateOne',
      () => AdminAuditLogModel.bulkWrite([{ updateOne: { filter: {}, update: { summary: 'x' } } }]),
    ],
    ['bulkWrite deleteMany', () => AdminAuditLogModel.bulkWrite([{ deleteMany: { filter: {} } }])],
  ];

  it.each(immutableOperations)('rejects %s', async (_name, operation) => {
    await adminAuditLogRepository.append(buildEntry());
    await expect(operation()).rejects.toThrow(/immutable/);
  });

  it('rejects re-saving a persisted document', async () => {
    const doc = await AdminAuditLogModel.create(buildEntry());
    doc.summary = 'changed';
    await expect(doc.save()).rejects.toThrow(/immutable/);
  });

  it('appendBackfill is idempotent on the supplied ids', async () => {
    const entries = [
      { ...buildEntry({ backfilled: true }), id: new Types.ObjectId().toString() },
      { ...buildEntry({ backfilled: true }), id: new Types.ObjectId().toString() },
    ];

    expect(await adminAuditLogRepository.appendBackfill(entries)).toEqual({ inserted: 2, duplicates: 0 });
    expect(await adminAuditLogRepository.appendBackfill(entries)).toEqual({ inserted: 0, duplicates: 2 });
    expect(await AdminAuditLogModel.countDocuments({})).toBe(2);
  });

  it('appendBackfill counts only the already-present entries as duplicates', async () => {
    const existing = { ...buildEntry(), id: new Types.ObjectId().toString() };
    const fresh = { ...buildEntry(), id: new Types.ObjectId().toString() };
    await adminAuditLogRepository.appendBackfill([existing]);

    expect(await adminAuditLogRepository.appendBackfill([existing, fresh])).toEqual({ inserted: 1, duplicates: 1 });
  });

  it('appendBackfill rethrows a non-duplicate write error', async () => {
    const invalid = { ...buildEntry(), id: new Types.ObjectId().toString(), action: undefined as unknown as string };

    await expect(adminAuditLogRepository.appendBackfill([invalid])).rejects.toThrow();
    expect(await AdminAuditLogModel.countDocuments({})).toBe(0);
  });

  it('appendBackfill rejects a batch with an invalid row even when other rows are already present', async () => {
    const existing = { ...buildEntry(), id: new Types.ObjectId().toString() };
    const invalid = { ...buildEntry(), id: new Types.ObjectId().toString(), action: undefined as unknown as string };
    const fresh = { ...buildEntry(), id: new Types.ObjectId().toString() };
    await adminAuditLogRepository.appendBackfill([existing]);

    await expect(adminAuditLogRepository.appendBackfill([existing, invalid, fresh])).rejects.toThrow();
    expect(await AdminAuditLogModel.countDocuments({})).toBe(1);
  });

  it('declares the query indexes', async () => {
    const keys = (await AdminAuditLogModel.listIndexes()).map(index => index.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        { occurredAt: -1, _id: -1 },
        { 'actor.userId': 1, occurredAt: -1, _id: -1 },
        { 'target.kind': 1, 'target.id': 1, occurredAt: -1, _id: -1 },
        { organizationId: 1, occurredAt: -1, _id: -1 },
        { category: 1, occurredAt: -1, _id: -1 },
        { action: 1, occurredAt: -1, _id: -1 },
        { severity: 1, occurredAt: -1, _id: -1 },
        { 'context.requestId': 1, occurredAt: -1, _id: -1 },
        { 'related.impersonationSessionId': 1, occurredAt: -1, _id: -1 },
      ])
    );
  });

  it('names exactly the indexes the previous key specs produced', async () => {
    const previousKeySpecs: Array<Record<string, 1 | -1>> = [
      { 'actor.userId': 1, occurredAt: -1 },
      { 'target.kind': 1, 'target.id': 1, occurredAt: -1 },
      { organizationId: 1, occurredAt: -1 },
      { category: 1, occurredAt: -1 },
      { action: 1, occurredAt: -1 },
    ];
    const scratch = AdminAuditLogModel.db.collection('adminauditlogs_superseded_index_names');
    for (const spec of previousKeySpecs) await scratch.createIndex(spec);

    const names = (await scratch.listIndexes().toArray()).map(index => String(index.name)).filter(n => n !== '_id_');
    await scratch.drop();

    expect(names).toEqual([...SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES]);
  });

  describe('reads', () => {
    const seed = async (overrides: Partial<NewAdminAuditEntry>[]): Promise<string[]> => {
      const entries = overrides.map(override => ({ ...buildEntry(override), id: new Types.ObjectId().toString() }));
      await adminAuditLogRepository.appendBackfill(entries);
      return entries.map(entry => entry.id);
    };
    const page = { limit: 50 };
    const listActions = async (filters: Parameters<typeof adminAuditLogRepository.list>[0]) =>
      (await adminAuditLogRepository.list(filters, page)).entries.map(entry => entry.action);

    it('list returns newest first and a cursor when more remain', async () => {
      const [oldestId, middleId, newestId] = await seed([
        { occurredAt: new Date('2026-10-01T00:00:00Z') },
        { occurredAt: new Date('2026-10-02T00:00:00Z') },
        { occurredAt: new Date('2026-10-03T00:00:00Z') },
      ]);

      const first = await adminAuditLogRepository.list({}, { limit: 2 });
      expect(first.entries.map(entry => entry.id)).toEqual([newestId, middleId]);
      expect(first.nextCursor).not.toBeNull();

      const second = await adminAuditLogRepository.list({}, { limit: 2, cursor: first.nextCursor ?? undefined });
      expect(second.entries.map(entry => entry.id)).toEqual([oldestId]);
      expect(second.nextCursor).toBeNull();
    });

    it('list pages through ties without gaps or repeats', async () => {
      const ids = await seed(Array.from({ length: 5 }, () => ({ occurredAt: new Date('2026-10-05T00:00:00Z') })));

      const collected: string[] = [];
      let cursor: { occurredAt: Date; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const result = await adminAuditLogRepository.list({}, { limit: 2, cursor });
        collected.push(...result.entries.map(entry => entry.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      expect(collected).toEqual([...ids].sort().reverse());
      expect(new Set(collected).size).toBe(5);
    });

    it('list bounds the query time so an unindexed filter fails fast', async () => {
      const maxTimeSpy = vi.spyOn(mongoose.Query.prototype, 'maxTimeMS');
      try {
        await adminAuditLogRepository.list({}, { limit: 2 });
        expect(maxTimeSpy).toHaveBeenCalledWith(expect.any(Number));
        expect(maxTimeSpy.mock.calls[0][0]).toBeGreaterThan(0);
      } finally {
        maxTimeSpy.mockRestore();
      }
    });

    it('list applies each filter', async () => {
      await seed([
        { action: 'a.base' },
        { action: 'user.deleted', category: 'account', severity: 'critical' },
        { action: 'user.undeleted_flag', category: 'account' },
        {
          action: 'by.other',
          actor: { kind: 'user', scope: 'organization', userId: 'admin-2', name: 'Two', wasAdmin: false },
        },
        { action: 'on.org', target: { kind: 'organization', id: 'org-9', displayName: 'Org' } },
        { action: 'via.script', context: { source: 'script', requestId: 'req-1' } },
        { action: 'in.session', related: { impersonationSessionId: 'sess-1' } },
        { action: 'early', occurredAt: new Date('2026-09-01T00:00:00Z') },
        { action: 'late', occurredAt: new Date('2026-11-01T00:00:00Z') },
      ]);

      expect(await listActions({ category: 'account' })).toEqual(expect.arrayContaining(['user.deleted']));
      expect((await listActions({ category: 'account' })).length).toBe(2);
      expect(await listActions({ severity: 'critical' })).toEqual(['user.deleted']);
      expect(await listActions({ action: 'a.base' })).toEqual(['a.base']);
      expect(await listActions({ verb: 'deleted' })).toEqual(['user.deleted']);
      expect(await listActions({ actorUserId: 'admin-2' })).toEqual(['by.other']);
      expect(await listActions({ targetKind: 'organization', targetId: 'org-9' })).toEqual(['on.org']);
      expect(await listActions({ source: 'script' })).toEqual(['via.script']);
      expect(await listActions({ actorScope: 'organization' })).toEqual(['by.other']);
      expect(await listActions({ requestId: 'req-1' })).toEqual(['via.script']);
      expect(await listActions({ impersonationSessionId: 'sess-1' })).toEqual(['in.session']);
      expect(await listActions({ from: '2026-11-01T00:00:00.000Z' })).toEqual(['late']);
      expect(await listActions({ to: '2026-09-01T00:00:00.000Z' })).toEqual(['early']);
    });

    it('findById returns an entry, and null for a non-ObjectId and for a missing id', async () => {
      const [id] = await seed([{}]);

      expect((await adminAuditLogRepository.findById(id))?.id).toBe(id);
      expect(await adminAuditLogRepository.findById('not-an-id')).toBeNull();
      expect(await adminAuditLogRepository.findById(new Types.ObjectId().toString())).toBeNull();
    });

    it('summarize counts each tile and ranks top granters', async () => {
      const grant = (userId: string) => ({
        category: 'credits' as const,
        actor: { kind: 'user' as const, scope: 'platform' as const, userId, name: 'Admin', wasAdmin: true },
      });
      await seed([
        grant('admin-1'),
        grant('admin-1'),
        grant('admin-1'),
        grant('admin-2'),
        { ...grant('admin-1'), occurredAt: new Date('2026-01-01T00:00:00Z') },
        { category: 'access', action: 'user.role.changed' },
        { category: 'access', action: 'user.impersonation.started' },
        { category: 'access', action: 'user.impersonation.ended' },
        { action: 'user.deleted', category: 'account' },
        { action: 'org.revoked.denied', category: 'org' },
      ]);

      const summary = await adminAuditLogRepository.summarize(new Date('2026-10-01T00:00:00Z'));

      expect(summary.creditGrants.count).toBe(4);
      expect(summary.creditGrants.topGranters[0]).toEqual({ userId: 'admin-1', name: 'Admin', count: 3 });
      expect(summary.permissionChanges).toBe(1);
      expect(summary.impersonations).toBe(1);
      expect(summary.deletions).toBe(1);
      expect(summary.deniedAttempts).toBe(1);
    });

    it('summarize bounds the aggregation time', async () => {
      const optionSpy = vi.spyOn(mongoose.Aggregate.prototype, 'option');
      try {
        await adminAuditLogRepository.summarize(new Date('2026-10-01T00:00:00Z'));
        expect(optionSpy).toHaveBeenCalledWith({ maxTimeMS: 15_000 });
      } finally {
        optionSpy.mockRestore();
      }
    });
  });
});
