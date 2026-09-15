import { describe, it, expect, beforeEach } from 'vitest';
import { AdminSupportAccessAction } from '@bike4mind/common';
import {
  AdminSupportAccessAuditLog,
  adminSupportAccessAuditLogRepository,
} from '../models/infra/admin/AdminSupportAccessAuditLogModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await AdminSupportAccessAuditLog.syncIndexes();
});

const baseEvent = {
  action: AdminSupportAccessAction.SessionRead,
  actorUserId: 'admin-1',
  targetUserId: 'owner-9',
  sessionId: 'sess-1',
  supportCase: 'ZD-4821',
};

describe('AdminSupportAccessAuditLog', () => {
  it('records who read what, for which case', async () => {
    const doc = await adminSupportAccessAuditLogRepository.record({
      ...baseEvent,
      actorIp: '203.0.113.7',
      actorUserAgent: 'b4m-admin/1.0',
      actorApiKeyId: 'key-abc',
      details: { page: 1, returned: 10 },
    });

    const found = await AdminSupportAccessAuditLog.findById(doc.id);
    expect(found?.action).toBe(AdminSupportAccessAction.SessionRead);
    expect(found?.actorUserId).toBe('admin-1');
    expect(found?.targetUserId).toBe('owner-9');
    expect(found?.sessionId).toBe('sess-1');
    expect(found?.supportCase).toBe('ZD-4821');
    expect(found?.actorIp).toBe('203.0.113.7');
    expect(found?.actorApiKeyId).toBe('key-abc');
    expect(found?.details).toMatchObject({ page: 1, returned: 10 });
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a write missing the support-case reference', async () => {
    await expect(AdminSupportAccessAuditLog.create({ ...baseEvent, supportCase: undefined })).rejects.toThrow();
  });

  it('rejects an unknown action', async () => {
    await expect(
      AdminSupportAccessAuditLog.create({ ...baseEvent, action: 'session.write' as never })
    ).rejects.toThrow();
  });

  it('sets a two-year TTL horizon', async () => {
    const before = Date.now();
    const doc = await adminSupportAccessAuditLogRepository.record(baseEvent);
    const after = Date.now();
    const twoYears = 730 * 24 * 60 * 60 * 1000;
    const exp = new Date(doc.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + twoYears - 1000);
    expect(exp).toBeLessThanOrEqual(after + twoYears + 1000);
  });

  it('supports the "who read this notebook?" query', async () => {
    await adminSupportAccessAuditLogRepository.record(baseEvent);
    await adminSupportAccessAuditLogRepository.record({
      ...baseEvent,
      action: AdminSupportAccessAction.SessionQuestsRead,
      actorUserId: 'admin-2',
    });

    const reads = await AdminSupportAccessAuditLog.find({ sessionId: 'sess-1' }).sort({ createdAt: -1 });
    expect(reads).toHaveLength(2);
    expect(reads.map(r => r.actorUserId).sort()).toEqual(['admin-1', 'admin-2']);
  });
});
