/**
 * Organization GitHub Repositories API
 *
 * Returns the list of repositories accessible to the organization's GitHub connection.
 * Used by the Allowed Repositories checklist UI.
 *
 * Security:
 * - Org owner or manager access required
 * - Rate limited to 60 requests per hour per organization
 * - Returns ALL accessible repos (skips whitelist filter) for configuration purposes
 *
 * @route GET /api/organizations/[id]/github/repositories - Get accessible repositories
 */

import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { rateLimit } from '@server/middlewares/rateLimit';

const logger = new Logger({ metadata: { component: 'org-github-repositories' } });

const handler = baseApi()
  // rate limited to prevent abuse - this makes real GitHub API calls
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

    // config UI needs every accessible repo, so the whitelist filter is skipped here
    const repositories = await service.listRepositories({ skipWhitelistFilter: true });

    repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));

    logger.info('[Org] Listed GitHub repositories', {
      count: repositories.length,
      organizationId: orgId,
      userId: user.id,
    });

    return res.json({
      repositories,
      // GitHub API returns at most 100 per page
      hasMore: repositories.length >= 100,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
