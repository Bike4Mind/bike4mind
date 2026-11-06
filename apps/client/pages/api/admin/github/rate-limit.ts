/**
 * Admin GitHub Rate Limit API
 *
 * Returns the current GitHub API rate limit status.
 *
 * Security:
 * - Admin-only access
 * - Rate limited to 60 requests per hour
 *
 * @route GET /api/admin/github/rate-limit - Get rate limit status
 */

import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@bike4mind/server-utils/services/githubService';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ApiKeyScope, isNearLimit } from '@bike4mind/common';

const logger = new Logger({ metadata: { component: 'admin-github-rate-limit' } });

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  // Rate limit to prevent abuse (60/hour - makes real API calls)
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  // GET - Get rate limit status
  .get(async (req, res) => {
    // Get the GitHub service for system default connection
    const service = await GitHubService.forSystem(logger);
    if (!service) {
      throw new NotFoundError('No GitHub connection configured or connection is disabled');
    }

    // Check rate limit
    const rateLimit = await service.checkRateLimit();

    logger.info('[Admin] Checked GitHub rate limit', {
      remaining: rateLimit.remaining,
      limit: rateLimit.limit,
      usagePercent: rateLimit.usagePercent,
      adminUserId: req.user!.id,
    });

    // Use shared isNearLimit function for consistent threshold
    return res.json({
      rateLimit: {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        resetAt: rateLimit.resetAt?.toISOString() ?? new Date().toISOString(),
        usagePercent: rateLimit.usagePercent ?? 0,
        isNearLimit: isNearLimit(rateLimit),
      },
    });
  });

export default handler;
