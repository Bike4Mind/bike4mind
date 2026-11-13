import type { Request } from 'express';
import { adminSettingsRepository, lakeAccessEventRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { LakeAccessSurface } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { resolveAuditPrincipal } from '@bike4mind/server-utils/dataLakes/resolveAuditPrincipal';
import { adminBypassLakeIds } from '@bike4mind/server-utils/dataLakes/index';

/** Audits a lake read door's response. Awaited (serverless freeze); best-effort except a non-member
 * admin read, whose failed write fails the request (strict case in recordLakeAccessEvent). */
export async function recordLakeRead(
  req: Request<unknown, unknown, unknown, unknown>,
  { lakeIds, fileIds, surface }: { lakeIds: string[]; fileIds?: string[]; surface: LakeAccessSurface }
): Promise<void> {
  const bypass = await adminBypassLakeIds(req, lakeIds);
  await dataLakeService.recordLakeAccessEvent(
    lakeAccessEventRepository,
    {
      ...resolveAuditPrincipal(req.user, req.apiKeyInfo),
      organizationId: normalizeId(req.user.organizationId),
      resolvedLakeIds: lakeIds,
      ...(fileIds?.length ? { fileIds: [...new Set(fileIds)] } : {}),
      ...(bypass.length ? { adminBypassLakeIds: bypass } : {}),
      surface,
    },
    req.logger,
    adminSettingsRepository
  );
}
