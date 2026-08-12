import { describe, it, expect } from 'vitest';
import { resolveLakeAuditRetention } from './resolveLakeAuditRetention';
import { LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS } from '@bike4mind/common';

function fakeDb(rows: Record<string, string>) {
  return {
    adminSettings: {
      findBySettingNames: async (names: string[]) =>
        names.filter(n => n in rows).map(n => ({ settingName: n, settingValue: rows[n] })),
      findAll: async () => Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue })),
    },
  } as never;
}

describe('resolveLakeAuditRetention', () => {
  it('resolves configured values, clamped', async () => {
    const result = await resolveLakeAuditRetention(
      fakeDb({ LakeAccessAuditRetentionDays: '600', LakeAccessQueryTextRetentionDays: '45' }),
      { skipCache: true }
    );
    expect(result.auditRetentionDays).toBe(600);
    expect(result.queryTextRetentionDays).toBe(45);
    expect(result.queryTextRetentionDays).toBeLessThan(result.auditRetentionDays);
  });

  it('falls back to the floor defaults when no settings are stored', async () => {
    const result = await resolveLakeAuditRetention(fakeDb({}), { skipCache: true });
    expect(result.auditRetentionDays).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
  });

  it('a settings outage returns the floor defaults and does not throw', async () => {
    const throwingDb = {
      adminSettings: {
        findBySettingNames: async () => {
          throw new Error('db unavailable');
        },
        findAll: async () => {
          throw new Error('db unavailable');
        },
      },
    } as never;
    const result = await resolveLakeAuditRetention(throwingDb, { skipCache: true });
    expect(result.auditRetentionDays).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
  });

  it('a below-floor configured value is still clamped up', async () => {
    const result = await resolveLakeAuditRetention(fakeDb({ LakeAccessAuditRetentionDays: '10' }), {
      skipCache: true,
    });
    expect(result.auditRetentionDays).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
  });
});
