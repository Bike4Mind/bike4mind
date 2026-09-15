/**
 * Admin GitHub Repositories API
 *
 * Returns the list of repositories accessible to the GitHub connection.
 * Used by the Allowed Repositories checklist UI.
 *
 * Security:
 * - Admin-only access
 * - Rate limited to 60 requests per hour
 * - Returns ALL accessible repos (skips whitelist filter) for configuration purposes
 *
 * @route GET /api/admin/github/repositories - Get accessible repositories
 */

import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError, ensureAdmin } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import { rateLimit } from '@server/middlewares/rateLimit';

const logger = new Logger({ metadata: { component: 'admin-github-repositories' } });

const handler = baseApi()
  // Rate limit to prevent abuse (60/hour - makes real GitHub API calls)
  .use(
    rateLimit({
      limit: 60,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  // GET - Get accessible repositories
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    // Get the GitHub service for system default connection
    const service = await GitHubService.forSystem(logger);
    if (!service) {
      throw new NotFoundError('No GitHub connection configured or connection is disabled');
    }

    // List ALL accessible repositories (skip whitelist filter for admin config UI)
    const repositories = await service.listRepositories({ skipWhitelistFilter: true });

    // Sort alphabetically by full_name for consistent display
    repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));

    logger.info('[Admin] Listed GitHub repositories', {
      count: repositories.length,
      adminUserId: req.user!.id,
    });

    return res.json({
      repositories,
      // Indicate if the list was truncated (GitHub API returns max 100)
      hasMore: repositories.length >= 100,
    });
  });

export default handler;
