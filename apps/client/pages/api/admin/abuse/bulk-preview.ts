import { ApiKeyScope, BulkAbusePreviewRequestSchema, type BulkAbusePreview } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { abuseService } from '@bike4mind/services';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  bulkAbuseCohortAdapters,
  bulkAbusePreviewAdapters,
  denySelfInBulkAbuseTarget,
} from '@server/admin/bulkAbuse/adapters';
import { assertOwnedDomain } from '@server/admin/bulkAbuse/assertOwnedDomain';
import { signBulkAbusePreviewToken } from '@server/admin/bulkAbuse/previewToken';

/**
 * Dry run of a bulk abuse response: who would be actioned, who is skipped and why, and what it
 * would change. Writes nothing. The returned previewToken is what bulk-execute.ts acts on.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const { target, actions } = BulkAbusePreviewRequestSchema.parse(req.body);
    await denySelfInBulkAbuseTarget(req, req.user, target);
    const domain = target.kind === 'domain' ? assertOwnedDomain(target.domain) : null;
    // A domain ban writes blockedEmailDomains, so it needs the settings route's permission too.
    if (target.kind === 'domain' && actions.ban && !req.ability?.can('update', AdminSettings)) {
      throw new ForbiddenError('Banning a domain needs permission to edit admin settings.');
    }

    const cohort = await abuseService.resolveBulkAbuseCohort(target, req.user.id, bulkAbuseCohortAdapters);
    const counts = await abuseService.previewBulkAbuseCounts(cohort.included, bulkAbusePreviewAdapters);
    const fingerprint = abuseService.bulkAbuseFingerprint(
      target,
      actions,
      cohort.included.map(user => user.id)
    );

    const preview: BulkAbusePreview = {
      ...counts,
      includedCount: cohort.included.length,
      excluded: cohort.excluded,
      hasMore: cohort.hasMore,
      nextAfterUserId: cohort.nextAfterUserId,
      blocksDomain: actions.ban ? domain : null,
      previewToken: signBulkAbusePreviewToken(req.user.id, fingerprint, cohort.upToUserId),
    };
    return res.json(preview);
  })
);

export default handler;
