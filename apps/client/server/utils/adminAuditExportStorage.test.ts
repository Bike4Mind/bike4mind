import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upload, getSignedUrl } = vi.hoisted(() => ({ upload: vi.fn(), getSignedUrl: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload, getSignedUrl }),
}));

import {
  ADMIN_AUDIT_EXPORT_PREFIX,
  ADMIN_AUDIT_EXPORT_URL_TTL_SECONDS,
  stageAdminAuditExport,
} from './adminAuditExportStorage';

describe('stageAdminAuditExport', () => {
  beforeEach(() => {
    upload.mockReset().mockResolvedValue(undefined);
    getSignedUrl.mockReset().mockResolvedValue('https://storage.example.test/signed');
  });

  it('uploads the CSV under the expiring export prefix and signs a short-lived attachment URL', async () => {
    const url = await stageAdminAuditExport('"a","b"', 'audit-log-2026-10-19.csv');

    expect(url).toBe('https://storage.example.test/signed');
    const [body, key, options] = upload.mock.calls[0];
    expect((body as Buffer).toString('utf8')).toBe('"a","b"');
    expect(key).toMatch(new RegExp(`^${ADMIN_AUDIT_EXPORT_PREFIX}[0-9a-f-]{36}/audit-log-2026-10-19\\.csv$`));
    expect(options).toEqual({ ContentType: 'text/csv; charset=utf-8' });
    expect(getSignedUrl).toHaveBeenCalledWith(key, 'get', {
      expiresIn: ADMIN_AUDIT_EXPORT_URL_TTL_SECONDS,
      ResponseContentDisposition: 'attachment; filename="audit-log-2026-10-19.csv"',
      audience: 'browser',
    });
    expect(ADMIN_AUDIT_EXPORT_URL_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it('propagates an upload failure without signing', async () => {
    upload.mockRejectedValue(new Error('storage down'));

    await expect(stageAdminAuditExport('x', 'f.csv')).rejects.toThrow('storage down');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
