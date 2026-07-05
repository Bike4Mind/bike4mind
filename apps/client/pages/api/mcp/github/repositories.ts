import { mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, InternalServerError, NotFoundError } from '@server/utils/errors';
import { decryptToken } from '@server/security/tokenEncryption';
import { z } from 'zod';

// Security fix: this used to be a raw NextApiRequest with no auth - any
// unauthenticated caller could pass a target userId in the body, fetch that
// user's private GitHub repos with their decrypted access token, and modify
// their selected repositories. Now scoped to req.user.id via baseApi().

// Maximum number of repositories to fetch (safety limit)
const MAX_REPOS = 500;

const SaveSelectionInput = z.object({
  selectedRepositories: z.array(z.string()),
});

/**
 * Parse GitHub Link header to extract next page URL
 * @see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
 */
function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

const getRepositoriesHandler = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const mcpServer = await mcpServerRepository.findOne({
    userId,
    name: McpServerName.Github,
  });

  if (!mcpServer || !mcpServer.enabled) {
    throw new BadRequestError('GitHub not connected');
  }

  const tokenVar = mcpServer.envVariables.find(env => env.key === 'GITHUB_ACCESS_TOKEN');

  if (!tokenVar || !tokenVar.value) {
    throw new BadRequestError('GitHub token not found');
  }

  req.logger.info('Fetching GitHub repositories', {
    userId,
    githubLogin: mcpServer.metadata?.githubLogin,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${decryptToken(tokenVar.value)}`,
    Accept: 'application/vnd.github.v3+json',
  };

  // Paginated fetch using Link header (GitHub best practice)
  const allRepos: Array<Record<string, unknown>> = [];
  let url: string | null =
    'https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated';
  let paginationInterrupted = false;

  while (url && allRepos.length < MAX_REPOS) {
    const response = await fetch(url, { headers });

    // Check rate limit headers
    const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') || '5000', 10);
    const limit = parseInt(response.headers.get('X-RateLimit-Limit') || '5000', 10);

    if (remaining < limit * 0.1) {
      req.logger.warn('GitHub API rate limit running low', { remaining, limit, userId });
    }

    if (remaining === 0) {
      const resetTime = response.headers.get('X-RateLimit-Reset');
      req.logger.error('GitHub API rate limit exceeded', { resetsAt: resetTime, userId });
      paginationInterrupted = true;
      break;
    }

    if (!response.ok) {
      const errorText = await response.text();
      req.logger.error('GitHub API error', { status: response.status, error: errorText });

      // Return partial results if we have some
      if (allRepos.length > 0) {
        req.logger.warn('Pagination interrupted, returning partial results', {
          fetchedCount: allRepos.length,
          userId,
        });
        paginationInterrupted = true;
        break;
      }

      if (response.status === 401) {
        throw new BadRequestError('GitHub token expired or invalid. Please reconnect.');
      }

      throw new InternalServerError('Failed to fetch repositories from GitHub');
    }

    const repos = await response.json();
    allRepos.push(...repos);

    url = getNextPageUrl(response.headers.get('Link'));
  }

  const formattedRepos = allRepos.map((repo: Record<string, unknown>) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: (repo.owner as Record<string, unknown>)?.login,
    private: repo.private,
    fork: repo.fork || false,
    description: repo.description,
    url: repo.html_url,
    updatedAt: repo.updated_at,
    permissions: {
      admin: (repo.permissions as Record<string, unknown>)?.admin || false,
      push: (repo.permissions as Record<string, unknown>)?.push || false,
      pull: (repo.permissions as Record<string, unknown>)?.pull || false,
    },
  }));

  req.logger.info('Successfully fetched repositories', {
    userId,
    count: formattedRepos.length,
    paginationInterrupted,
  });

  const selectedRepositories = mcpServer.metadata?.selectedRepositories || [];

  return res.status(200).json({
    repositories: formattedRepos,
    selectedRepositories: selectedRepositories.map(r => r.fullName),
    total: formattedRepos.length,
  });
});

const saveSelectionHandler = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { selectedRepositories } = SaveSelectionInput.parse(req.body);

  const mcpServer = await mcpServerRepository.findOne({
    userId,
    name: McpServerName.Github,
  });

  if (!mcpServer || !mcpServer.enabled) {
    throw new NotFoundError('GitHub not connected');
  }

  const formattedRepos = selectedRepositories.map((fullName: string) => {
    const [owner, repo] = fullName.split('/');
    return { fullName, owner, repo };
  });

  if (!mcpServer.metadata) {
    mcpServer.metadata = {};
  }
  mcpServer.metadata.selectedRepositories = formattedRepos;

  await mcpServerRepository.update(mcpServer);

  req.logger.info('Successfully updated repository selection', {
    userId,
    selectedCount: formattedRepos.length,
  });

  return res.status(200).json({
    success: true,
    selectedRepositories: formattedRepos.map(r => r.fullName),
  });
});

const handler = baseApi()
  .get(getRepositoriesHandler)
  .post(getRepositoriesHandler) // backward compatibility - old clients used POST
  .patch(saveSelectionHandler);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
