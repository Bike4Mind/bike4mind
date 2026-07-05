/**
 * Admin GitHub Test Connection API
 *
 * Tests the GitHub API connection and returns authentication info and latency.
 *
 * Security:
 * - Admin-only access
 * - Rate limited to 30 tests per hour
 *
 * @route POST /api/admin/github/test - Test the GitHub connection
 */

import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError, ensureAdmin } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import { rateLimit } from '@server/middlewares/rateLimit';

const logger = new Logger({ metadata: { component: 'admin-github-test' } });

const handler = baseApi()
  // Rate limit to prevent abuse (30 tests/hour - makes real API calls)
  .use(
    rateLimit({
      limit: 30,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  // POST - Test GitHub connection
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    // Get the GitHub service for system default connection
    const service = await GitHubService.forSystem(logger);
    if (!service) {
      throw new NotFoundError('No GitHub connection configured or connection is disabled');
    }

    // Test the connection
    const result = await service.testConnection();

    logger.info('[Admin] Tested GitHub connection', {
      success: result.success,
      ...(result.success && { type: result.type }),
      latencyMs: result.latencyMs,
      adminUserId: req.user!.id,
    });

    return res.json(result);
  });

export default handler;
