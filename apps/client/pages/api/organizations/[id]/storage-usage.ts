import { fabFileRepository, userRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { verifyOrgAdminRead } from '@server/utils/orgAccess';

// One `$group` over the org's rows; the cap only matters for an org with a very large file count,
// where a slow answer is worse than a failed one the UI can retry.
export const ORG_STORAGE_USAGE_MAX_TIME_MS = 10000;
export const ORG_STORAGE_USAGE_RATE_LIMIT = 30;
const ONE_MINUTE_MS = 60 * 1000;

/**
 * GET /api/organizations/:id/storage-usage - the org's storage pool: the counter quota checks enforce,
 * the effective limit in bytes, and the charged rows by uploader (OrganizationStorageUsage). Read tier
 * (verifyOrgAdminRead): owner, manager, appointed admin or platform admin; anyone else gets 404.
 * First-party only (`jwtOnly`), like users/me/storage-breakdown, so it needs no public API contract.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: ORG_STORAGE_USAGE_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'org-storage-usage' }))
  .get(async (req, res) => {
    const organizationId = typeof req.query.id === 'string' ? req.query.id : '';
    const { org } = await verifyOrgAdminRead(req.user!, organizationId);

    const usage = await organizationService.getOrganizationStorageUsage(
      org,
      { db: { fabFiles: fabFileRepository, users: userRepository } },
      { maxTimeMS: ORG_STORAGE_USAGE_MAX_TIME_MS }
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(usage);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
