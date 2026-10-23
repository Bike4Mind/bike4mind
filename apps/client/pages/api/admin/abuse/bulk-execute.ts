import {
  ApiKeyScope,
  BulkAbuseExecuteRequestSchema,
  normalizeEmailDomain,
  type BulkAbuseExecuteResult,
} from '@bike4mind/common';
import { abuseService } from '@bike4mind/services';
import { BadRequestError, ConflictError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { addBlockedEmailDomain } from '@server/admin/bulkAbuse/addBlockedEmailDomain';
import {
  bulkAbuseCohortAdapters,
  bulkAbuseExecuteAdapters,
  denySelfInBulkAbuseTarget,
} from '@server/admin/bulkAbuse/adapters';
import { verifyBulkAbusePreviewToken } from '@server/admin/bulkAbuse/previewToken';

/**
 * Runs a previewed bulk abuse response. The cohort is resolved again and must match the preview
 * token exactly, so an admin can only execute what they were shown. Each user is its own
 * transaction: failures are reported per user and the rest continue.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const { target, actions, previewToken, reason: rawReason } = BulkAbuseExecuteRequestSchema.parse(req.body);
    await denySelfInBulkAbuseTarget(req, req.user, target);
    const reason = parseAdminActionReason(rawReason);

    const preview = verifyBulkAbusePreviewToken(previewToken);
    if (!preview || preview.adminId !== req.user.id) {
      throw new BadRequestError('This preview has expired or was not yours. Run the preview again.');
    }
    const cohort = await abuseService.resolveBulkAbuseCohort(target, req.user.id, bulkAbuseCohortAdapters);
    const includedIds = cohort.included.map(user => user.id);
    if (abuseService.bulkAbuseFingerprint(target, actions, includedIds) !== preview.fingerprint) {
      throw new ConflictError('The affected users or actions changed since the preview. Run the preview again.');
    }

    // Block the domain first, so no new account can sign up on it while the cohort is processed.
    const blockedDomain = target.kind === 'domain' && actions.ban ? normalizeEmailDomain(target.domain) : null;
    if (blockedDomain) await addBlockedEmailDomain(req, blockedDomain);

    const results = await abuseService.executeBulkAbuse(
      cohort.included,
      actions,
      req.user.id,
      bulkAbuseExecuteAdapters(req, reason, req.logger)
    );

    const succeeded = results.filter(result => result.status === 'succeeded');
    const result: BulkAbuseExecuteResult = {
      results,
      excluded: cohort.excluded,
      hasMore: cohort.hasMore,
      nextAfterUserId: cohort.nextAfterUserId,
      succeededCount: succeeded.length,
      failedCount: results.length - succeeded.length,
      bannedCount: results.filter(entry => entry.steps.ban === 'applied').length,
      revokedApiKeyCount: results.reduce((sum, entry) => sum + entry.revokedApiKeys, 0),
      clawedBackCredits: results.reduce((sum, entry) => sum + entry.clawedBackCredits, 0),
      blockedDomain,
    };

    await recordAdminActionFromRequest(req, {
      action: 'abuse.bulk.executed',
      target: {
        kind: 'system',
        id: 'bulk-abuse-response',
        displayName:
          target.kind === 'domain' ? (blockedDomain ?? target.domain) : `${includedIds.length} selected users`,
      },
      summary: `bulk abuse response: ${result.succeededCount} succeeded, ${result.failedCount} failed, ${cohort.excluded.length} excluded`,
      reason,
      details: {
        target: target.kind === 'domain' ? { kind: 'domain', domain: normalizeEmailDomain(target.domain) } : target,
        actions,
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
        excludedCount: cohort.excluded.length,
        bannedCount: result.bannedCount,
        revokedApiKeyCount: result.revokedApiKeyCount,
        clawedBackCredits: result.clawedBackCredits,
        blockedDomain,
        hasMore: result.hasMore,
      },
    });

    return res.json(result);
  })
);

export default handler;
