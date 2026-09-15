/**
 * Organization GitHub Rate Limit API
 *
 * Returns the current GitHub API rate limit status for the organization's connection.
 *
 * Security:
 * - Org owner or manager access required
 * - Rate limited to 60 requests per hour per organization
 *
 * @route GET /api/organizations/[id]/github/rate-limit - Get rate limit status
 */

import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isNearLimit } from '@bike4mind/common';

const logger = new Logger({ metadata: { component: 'org-github-rate-limit' } });

const handler = baseApi()
  // rate limited to prevent abuse - this makes a real GitHub API call
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  .get(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    const service = await GitHubService.forOrganization(orgId, logger);
    if (!service) {
      throw new NotFoundError('No GitHub connection configured or connection is disabled');
    }

    const rateLimitInfo = await service.checkRateLimit();

    logger.info('[Org] Checked GitHub rate limit', {
      remaining: rateLimitInfo.remaining,
      limit: rateLimitInfo.limit,
      usagePercent: rateLimitInfo.usagePercent,
      organizationId: orgId,
      userId: user.id,
    });

    // shared isNearLimit keeps the threshold consistent with other endpoints
    return res.json({
      rateLimit: {
        limit: rateLimitInfo.limit,
        remaining: rateLimitInfo.remaining,
        resetAt: rateLimitInfo.resetAt?.toISOString() ?? new Date().toISOString(),
        usagePercent: rateLimitInfo.usagePercent ?? 0,
        isNearLimit: isNearLimit(rateLimitInfo),
      },
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
