import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import { OrganizationAuditEventModel, organizationRepository } from '@bike4mind/database/infra';
import { getFilesStorage } from './storage/index';
import { isMissingObjectError, MAX_ACCOUNT_EXPORT_LEASE_WAITS } from './accountDataExport';
import { recordOrganizationAuditEvent } from './organizationAudit';

export const ORGANIZATION_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const organizationId = z.string().regex(/^[a-f\d]{24}$/i);
export const organizationExportQuery = z.object({ id: organizationId.transform(id => id.toLowerCase()) });
export const organizationExportPayload = organizationExportQuery.extend({
  kind: z.literal('organization'),
  exportJobId: z.uuid(),
  userId: z.string().min(1),
  leaseWaits: z.number().int().min(1).max(MAX_ACCOUNT_EXPORT_LEASE_WAITS).optional(),
});
export const organizationExportPrefix = (userId: string): string =>
  `exports/organization-data/${encodeURIComponent(z.string().min(1).parse(userId))}/`;

export const organizationExportKey = (id: string, userId: string, jobId: string): string =>
  `${organizationExportPrefix(userId)}${organizationExportQuery.parse({ id }).id}/${z.uuid().parse(jobId)}.zip`;

/** Old objects used the original stored spelling and raw user id; never normalize that exact locator. */
export const legacyOrganizationExportKey = (id: string, userId: string, jobId: string): string =>
  `exports/organizations/${organizationId.parse(id)}/${z.string().min(1).parse(userId)}/${z.uuid().parse(jobId)}.zip`;

/** Only validated hex IDs reach this anchored historical alias match. */
export const organizationExportScope = (id: string, userId: string, jobId?: string) => ({
  organizationId: new RegExp(`^${organizationExportQuery.parse({ id }).id}$`, 'i'),
  actorUserId: z.string().min(1).parse(userId),
  ...(jobId === undefined ? {} : { targetId: z.uuid().parse(jobId) }),
});

export const findOrganizationExportRequest = (id: string, userId: string, jobId: string) =>
  OrganizationAuditEventModel.findOne({
    ...organizationExportScope(id, userId, jobId),
    action: 'export.requested',
  }).lean();

type ExportRequestLocator = { organizationId: string; actorUserId: string; targetId?: string };

export const legacyOrganizationExportLocator = z.object({
  organizationId,
  actorUserId: z.string().min(1),
  targetId: z.uuid(),
});

export function organizationExportKeysForRequest(
  id: string,
  userId: string,
  jobId: string,
  request: ExportRequestLocator
): readonly string[] {
  const canonical = organizationExportQuery.parse({ id }).id;
  const locator = legacyOrganizationExportLocator.parse(request);
  if (
    organizationExportQuery.parse({ id: locator.organizationId }).id !== canonical ||
    locator.actorUserId !== userId ||
    locator.targetId !== jobId
  )
    throw new Error('Organization export locator does not match its request');
  return [
    organizationExportKey(canonical, userId, jobId),
    legacyOrganizationExportKey(locator.organizationId, userId, locator.targetId),
  ];
}

/** Prefer the new subject-addressable key; only a missing object selects the validated legacy key. */
export async function findOrganizationExportObject(
  storage: Pick<ReturnType<typeof getFilesStorage>, 'getMetadata'>,
  id: string,
  userId: string,
  jobId: string,
  request: ExportRequestLocator
) {
  for (const key of organizationExportKeysForRequest(id, userId, jobId, request)) {
    try {
      return { key, metadata: await storage.getMetadata(key) };
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
    }
  }
  return null;
}

export async function requireOrganizationExportOwner(user: { id: string; impersonatedBy?: string }, id: string) {
  const org = await organizationRepository.findById(id);
  if (!org) throw new NotFoundError('Organization not found');
  if (user.impersonatedBy || org.userId !== user.id)
    throw new ForbiddenError('Only the owner can export organization data');
  return org;
}

export async function organizationExportStatus(id: string, userId: string, exportJobId: string, download = false) {
  const filter = organizationExportScope(id, userId, exportJobId);
  const request = await findOrganizationExportRequest(id, userId, exportJobId);
  if (!request) throw new NotFoundError('Export not found');
  const expiresAt = new Date(request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS);
  if (expiresAt.getTime() <= Date.now()) return { status: 'expired' as const, exportJobId };
  const storage = getFilesStorage();
  const existing = await findOrganizationExportObject(storage, id, userId, exportJobId, request);
  if (!existing) {
    const failed = await OrganizationAuditEventModel.exists({ ...filter, action: 'export.failed' });
    return { status: failed ? ('failed' as const) : ('pending' as const), exportJobId };
  }
  if (!download) return { status: 'ready' as const, exportJobId, expiresAt: expiresAt.toISOString() };
  const remainingSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  if (remainingSeconds < 1) return { status: 'expired' as const, exportJobId };
  const url = await storage.getSignedUrl(existing.key, 'get', {
    audience: 'browser',
    expiresIn: Math.min(300, remainingSeconds),
    ResponseContentDisposition: 'attachment; filename="organization-data.zip"',
  });
  await recordOrganizationAuditEvent({
    organizationId: organizationExportQuery.parse({ id }).id,
    actorUserId: userId,
    targetId: exportJobId,
    action: 'export.downloaded',
  });
  return { status: 'ready' as const, exportJobId, url, expiresAt: expiresAt.toISOString() };
}
