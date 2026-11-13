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
  organizationExportStatus,
  requireOrganizationExportOwner,
} from './organizationDataExport';

beforeEach(() => {
  vi.clearAllMocks();
  h.org.mockResolvedValue({ userId: 'owner' });
  h.request.mockResolvedValue({ occurredAt: new Date() });
  h.metadata.mockResolvedValue({});
  h.sign.mockResolvedValue('https://storage.example.test/export');
  h.failed.mockResolvedValue(null);
});

describe('organization export authorization and expiry', () => {
  it('admits only the current owner, not managers, members, platform admins or impersonators', async () => {
    await expect(requireOrganizationExportOwner({ id: 'owner' }, 'org')).resolves.toBeTruthy();
    for (const id of ['manager', 'member', 'platform', 'outsider']) {
      await expect(requireOrganizationExportOwner({ id }, 'org')).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(requireOrganizationExportOwner({ id: 'owner', impersonatedBy: 'admin' }, 'org')).rejects.toMatchObject(
      { statusCode: 403 }
    );
    h.org.mockResolvedValue({ userId: 'successor' });
    await expect(requireOrganizationExportOwner({ id: 'owner' }, 'org')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('scopes request lookup and storage to organization, requester and job', async () => {
    const result = await organizationExportStatus('org', 'owner', 'job', true);
    expect(h.request).toHaveBeenCalledWith({
      organizationId: 'org',
      actorUserId: 'owner',
      targetId: 'job',
      action: 'export.requested',
    });
    expect(h.metadata).toHaveBeenCalledWith(organizationExportKey('org', 'owner', 'job'));
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
    await expect(organizationExportStatus('other-org', 'other-owner', 'job')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.metadata).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('does not sign or audit a download when only polling readiness', async () => {
    expect(await organizationExportStatus('org', 'owner', 'job')).toMatchObject({ status: 'ready' });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses expired exports even while storage still retains them', async () => {
    h.request.mockResolvedValue({ occurredAt: new Date(Date.now() - ORGANIZATION_EXPORT_TTL_MS) });
    expect(await organizationExportStatus('org', 'owner', 'job')).toEqual({ status: 'expired', exportJobId: 'job' });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('never signs beyond the remaining export lifetime', async () => {
    h.request.mockResolvedValue({ occurredAt: new Date(Date.now() - ORGANIZATION_EXPORT_TTL_MS + 60000) });
    await organizationExportStatus('org', 'owner', 'job', true);
    expect(h.sign.mock.calls[0][2].expiresIn).toBeLessThanOrEqual(60);
  });

  it('reports pending and failed jobs without signing, and propagates storage outages', async () => {
    h.metadata.mockRejectedValue(Object.assign(new Error('Missing'), { name: 'NotFound' }));
    expect(await organizationExportStatus('org', 'owner', 'job')).toMatchObject({ status: 'pending' });
    h.failed.mockResolvedValue({ _id: 'failed' });
    expect(await organizationExportStatus('org', 'owner', 'job')).toMatchObject({ status: 'failed' });
    h.metadata.mockRejectedValue(new Error('storage unavailable'));
    await expect(organizationExportStatus('org', 'owner', 'job')).rejects.toThrow('storage unavailable');
    expect(h.sign).not.toHaveBeenCalled();
  });
});
