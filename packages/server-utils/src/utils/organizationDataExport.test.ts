import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  org: vi.fn(),
  request: vi.fn(),
  failed: vi.fn(),
  metadata: vi.fn(),
  sign: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: h.org },
  OrganizationAuditEventModel: { findOne: (filter: unknown) => ({ lean: () => h.request(filter) }), exists: h.failed },
}));
vi.mock('./storage/index', () => ({ getFilesStorage: () => ({ getMetadata: h.metadata, getSignedUrl: h.sign }) }));
vi.mock('./organizationAudit', () => ({ recordOrganizationAuditEvent: h.audit }));
import {
  ORGANIZATION_EXPORT_TTL_MS,
  organizationExportKey,
  legacyOrganizationExportKey,
  organizationExportQuery,
  organizationExportStatus,
  requireOrganizationExportOwner,
} from './organizationDataExport';
const organizationId = 'a'.repeat(24);
const exportJobId = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
const requestFor = (occurredAt = new Date(), id = organizationId) => ({
  organizationId: id,
  actorUserId: 'owner',
  targetId: exportJobId,
  occurredAt,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.org.mockResolvedValue({ id: organizationId, userId: 'owner' });
  h.request.mockResolvedValue(requestFor());
  h.metadata.mockResolvedValue({});
  h.sign.mockResolvedValue('https://storage.example.test/export');
  h.failed.mockResolvedValue(null);
});

describe('organization export authorization and expiry', () => {
  it('normalizes organization ids before deriving the subject-addressable key', () => {
    expect(organizationExportQuery.parse({ id: organizationId.toUpperCase() })).toEqual({ id: organizationId });
    expect(organizationExportKey(organizationId.toUpperCase(), 'subject/one', exportJobId)).toBe(
      `exports/organization-data/subject%2Fone/${organizationId}/${exportJobId}.zip`
    );
  });

  it('uses the original request spelling for a historical object without extending its lifetime', async () => {
    const originalId = organizationId.toUpperCase();
    const occurredAt = new Date(Date.now() - 60_000);
    h.request.mockResolvedValue(requestFor(occurredAt, originalId));
    h.metadata.mockRejectedValueOnce(Object.assign(new Error('Missing'), { name: 'NotFound' }));
    const result = await organizationExportStatus(organizationId, 'owner', exportJobId, true);
    const legacy = legacyOrganizationExportKey(originalId, 'owner', exportJobId);
    expect(h.metadata.mock.calls.map(([key]) => key)).toEqual([
      organizationExportKey(organizationId, 'owner', exportJobId),
      legacy,
    ]);
    expect(h.sign).toHaveBeenCalledWith(legacy, 'get', expect.objectContaining({ expiresIn: 300 }));
    expect(result).toMatchObject({
      expiresAt: new Date(occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS).toISOString(),
    });
  });

  it('does not fall back to an old key after a permission or network failure', async () => {
    h.metadata.mockRejectedValue(new Error('Access denied'));
    await expect(organizationExportStatus(organizationId, 'owner', exportJobId, true)).rejects.toThrow('Access denied');
    expect(h.metadata).toHaveBeenCalledTimes(1);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('admits only the current owner, not managers, members, platform admins or impersonators', async () => {
    await expect(requireOrganizationExportOwner({ id: 'owner' }, organizationId)).resolves.toBeTruthy();
    for (const id of ['manager', 'member', 'platform', 'outsider']) {
      await expect(requireOrganizationExportOwner({ id }, organizationId)).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(
      requireOrganizationExportOwner({ id: 'owner', impersonatedBy: 'admin' }, organizationId)
    ).rejects.toMatchObject({ statusCode: 403 });
    h.org.mockResolvedValue({ userId: 'successor' });
    await expect(requireOrganizationExportOwner({ id: 'owner' }, organizationId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('scopes request lookup and storage to organization, requester and job', async () => {
    const result = await organizationExportStatus(organizationId, 'owner', exportJobId, true);
    expect(h.request).toHaveBeenCalledWith({
      organizationId: new RegExp(`^${organizationId}$`, 'i'),
      actorUserId: 'owner',
      targetId: exportJobId,
      action: 'export.requested',
    });
    expect(h.metadata).toHaveBeenCalledWith(organizationExportKey(organizationId, 'owner', exportJobId));
    expect(result).toMatchObject({ status: 'ready', url: 'https://storage.example.test/export' });
    expect(h.sign).toHaveBeenCalledWith(
      expect.any(String),
      'get',
      expect.objectContaining({ audience: 'browser', expiresIn: 300 })
    );
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'export.downloaded' }));
  });

  it('refuses a job from another org or requester before accessing storage', async () => {
    h.request.mockResolvedValue(null);
    await expect(organizationExportStatus('b'.repeat(24), 'other-owner', exportJobId)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.metadata).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('does not sign or audit a download when only polling readiness', async () => {
    expect(await organizationExportStatus(organizationId, 'owner', exportJobId)).toMatchObject({ status: 'ready' });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses expired exports even while storage still retains them', async () => {
    h.request.mockResolvedValue(requestFor(new Date(Date.now() - ORGANIZATION_EXPORT_TTL_MS)));
    expect(await organizationExportStatus(organizationId, 'owner', exportJobId)).toEqual({
      status: 'expired',
      exportJobId: exportJobId,
    });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('never signs beyond the remaining export lifetime', async () => {
    h.request.mockResolvedValue(requestFor(new Date(Date.now() - ORGANIZATION_EXPORT_TTL_MS + 60000)));
    await organizationExportStatus(organizationId, 'owner', exportJobId, true);
    expect(h.sign.mock.calls[0][2].expiresIn).toBeLessThanOrEqual(60);
  });

  it('reports pending and failed jobs without signing, and propagates storage outages', async () => {
    h.metadata.mockRejectedValue(Object.assign(new Error('Missing'), { name: 'NotFound' }));
    expect(await organizationExportStatus(organizationId, 'owner', exportJobId)).toMatchObject({ status: 'pending' });
    h.failed.mockResolvedValue({ _id: 'failed' });
    expect(await organizationExportStatus(organizationId, 'owner', exportJobId)).toMatchObject({ status: 'failed' });
    h.metadata.mockRejectedValue(new Error('storage unavailable'));
    await expect(organizationExportStatus(organizationId, 'owner', exportJobId)).rejects.toThrow('storage unavailable');
    expect(h.sign).not.toHaveBeenCalled();
  });
});
