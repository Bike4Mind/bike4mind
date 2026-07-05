import { mcpServerRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const logger = new Logger();

/**
 * Retry helper with exponential backoff
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retry attempts
 * @param baseDelayMs - Base delay in milliseconds (doubles each retry)
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 100ms, 200ms, 400ms
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms`, { error });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Get user's selected GitHub repositories for AI access
 * Returns empty array if user hasn't selected any repos
 * Retries up to 3 times with exponential backoff on transient errors
 */
export async function getUserSelectedRepositories(userId: string): Promise<string[]> {
  try {
    const mcpServer = await retryWithBackoff(
      () =>
        mcpServerRepository.findOne({
          userId,
          name: McpServerName.Github,
        }),
      3,
      100
    );

    if (!mcpServer || !mcpServer.enabled) {
      logger.info('GitHub not connected', { userId });
      return [];
    }

    const selectedRepos = mcpServer.metadata?.selectedRepositories || [];
    const repoNames = selectedRepos.map(r => r.fullName);

    logger.info('Retrieved selected repositories', { userId, count: repoNames.length, repos: repoNames });
    return repoNames;
  } catch (error) {
    logger.error('Failed to fetch selected repositories after retries', { userId, error });
    return [];
  }
}

/**
 * Check if user has GitHub connected
 */
export async function isGitHubConnected(userId: string): Promise<boolean> {
  try {
    const mcpServer = await mcpServerRepository.findOne({
      userId,
      name: McpServerName.Github,
    });

    return !!(mcpServer && mcpServer.enabled);
  } catch (error) {
    logger.error('Failed to check GitHub connection', { userId, error });
    return false;
  }
}

/**
 * Get selected repositories for MCP client with logging
 * Used by getMcpClient adapters to fetch repository whitelist for security filtering
 *
 * @param userId - User ID to fetch repositories for
 * @param serverName - MCP server name (only 'github' requires repository filtering)
 * @returns Array of repository full names (e.g., ['owner/repo']) or undefined if not GitHub
 */
export async function getSelectedRepositoriesForMcp(userId: string, serverName: string): Promise<string[] | undefined> {
  // Only GitHub requires repository filtering
  if (serverName !== 'github') {
    return undefined;
  }

  try {
    const selectedRepositories = await getUserSelectedRepositories(userId);
    return selectedRepositories;
  } catch (error) {
    logger.error('Failed to fetch selected repositories for MCP', { userId, serverName, error });
    // Return empty array (fail-secure) instead of undefined to prevent unrestricted access
    return [];
  }
}
