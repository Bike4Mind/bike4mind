/**
 * Organization GitHub Test Connection API
 *
 * Tests the GitHub API connection and returns authentication info and latency.
 *
 * Security:
 * - Org owner or manager access required
 * - Rate limited to 30 tests per hour per organization
 * - Audit logged
 *
 * @route POST /api/organizations/[id]/github/test - Test the GitHub connection
 */

import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logTestExecuted } from '@server/integrations/github/githubConnectionAuditLog';
import { orgGitHubConnectionRepository } from '@bike4mind/database';

const logger = new Logger({ metadata: { component: 'org-github-test' } });

const handler = baseApi()
  // P1: Rate limit to prevent abuse (30 tests/hour - makes real API calls)
  .use(
    rateLimit({
      limit: 30,
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  .post(async (req, res) => {
    const orgId = req.query.id as string;
    const user = req.user!;

    await verifyOrgAccess(user, orgId);

    const connection = await orgGitHubConnectionRepository.findByOrganizationId(orgId);
    if (!connection) {
      throw new NotFoundError('No GitHub connection found for this organization');
    }

    const service = await GitHubService.forOrganization(orgId, logger);
    if (!service) {
      throw new NotFoundError('No GitHub connection configured or connection is disabled');
    }

    const result = await service.testConnection();

    logTestExecuted(
      {
        connectionId: connection.id,
        organizationId: orgId,
        actorUserId: user.id,
        connectionType: connection.connectionType,
      },
      result.success ? 'success' : 'failure',
      result.success ? undefined : (result as { error?: string }).error
    );

    logger.info('[Org] Tested GitHub connection', {
      success: result.success,
      ...(result.success && { type: result.type }),
      latencyMs: result.latencyMs,
      organizationId: orgId,
      userId: user.id,
    });

    return res.json(result);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
