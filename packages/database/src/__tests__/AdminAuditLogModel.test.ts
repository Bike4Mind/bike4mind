import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import type { NewAdminAuditEntry } from '@bike4mind/common';
import { AdminAuditLogModel, adminAuditLogRepository } from '../models/infra/admin/AdminAuditLogModel';
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

  it('rejects updates', async () => {
    await adminAuditLogRepository.append(buildEntry());
    await expect(AdminAuditLogModel.updateOne({}, { summary: 'x' })).rejects.toThrow(/immutable/);
  });

  it('rejects deletes', async () => {
    await adminAuditLogRepository.append(buildEntry());
    await expect(AdminAuditLogModel.deleteOne({})).rejects.toThrow(/immutable/);
    await expect(AdminAuditLogModel.deleteMany({})).rejects.toThrow(/immutable/);
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

  it('declares the query indexes', async () => {
    const keys = (await AdminAuditLogModel.listIndexes()).map(index => index.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        { occurredAt: -1, _id: -1 },
        { 'actor.userId': 1, occurredAt: -1 },
        { 'target.kind': 1, 'target.id': 1, occurredAt: -1 },
        { organizationId: 1, occurredAt: -1 },
        { category: 1, occurredAt: -1 },
        { action: 1, occurredAt: -1 },
      ])
    );
  });
});
