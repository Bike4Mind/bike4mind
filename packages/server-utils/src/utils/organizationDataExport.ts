import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import { OrganizationAuditEventModel, organizationRepository } from '@bike4mind/database/infra';
import { getFilesStorage } from './storage/index';
import { isMissingObjectError } from './accountDataExport';
import { recordOrganizationAuditEvent } from './organizationAudit';

export const ORGANIZATION_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const organizationExportQuery = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });
export const organizationExportPayload = organizationExportQuery.extend({
  kind: z.literal('organization'),
  exportJobId: z.uuid(),
  userId: z.string().min(1),
});
export const organizationExportKey = (id: string, userId: string, jobId: string) =>
  `exports/organizations/${id}/${userId}/${jobId}.zip`;

export async function requireOrganizationExportOwner(user: { id: string; impersonatedBy?: string }, id: string) {
  const org = await organizationRepository.findById(id);
  if (!org) throw new NotFoundError('Organization not found');
  if (user.impersonatedBy || org.userId !== user.id)
    throw new ForbiddenError('Only the owner can export organization data');
  return org;
}

export async function organizationExportStatus(id: string, userId: string, exportJobId: string, download = false) {
  const filter = { organizationId: id, actorUserId: userId, targetId: exportJobId };
  const request = await OrganizationAuditEventModel.findOne({ ...filter, action: 'export.requested' }).lean();
  if (!request) throw new NotFoundError('Export not found');
  const expiresAt = new Date(request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS);
  if (expiresAt.getTime() <= Date.now()) return { status: 'expired' as const, exportJobId };
  const storage = getFilesStorage();
  const key = organizationExportKey(id, userId, exportJobId);
  try {
    await storage.getMetadata(key);
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    const failed = await OrganizationAuditEventModel.exists({ ...filter, action: 'export.failed' });
    return { status: failed ? ('failed' as const) : ('pending' as const), exportJobId };
  }
  if (!download) return { status: 'ready' as const, exportJobId, expiresAt: expiresAt.toISOString() };
  const remainingSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  if (remainingSeconds < 1) return { status: 'expired' as const, exportJobId };
  const url = await storage.getSignedUrl(key, 'get', {
    audience: 'browser',
    expiresIn: Math.min(300, remainingSeconds),
    ResponseContentDisposition: 'attachment; filename="organization-data.zip"',
  });
  await recordOrganizationAuditEvent({ ...filter, action: 'export.downloaded' });
  return { status: 'ready' as const, exportJobId, url, expiresAt: expiresAt.toISOString() };
}
