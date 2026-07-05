/**
 * GitHub MCP Server - Octokit Client
 *
 * Initializes and exports the Octokit client for GitHub API access.
 * Includes rate limit header interception for observability.
 */

import { Octokit } from '@octokit/rest';
import { parseRateLimitHeaders, isNearLimit, buildRateLimitLogEntry } from '@bike4mind/common';
import { githubToken } from './config.js';

// Initialize Octokit client with explicit type annotation for portability
export const octokit: InstanceType<typeof Octokit> = new Octokit({
  auth: githubToken,
});

// Intercept all responses to capture rate limit headers
octokit.hook.after('request', (response, options) => {
  const headers = (response as { headers?: Record<string, string> }).headers;
  if (!headers) return;

  const rateLimitInfo = parseRateLimitHeaders(headers);
  if (rateLimitInfo.remaining !== null) {
    const logEntry = buildRateLimitLogEntry('github', String(options.url ?? ''), rateLimitInfo);
    console.error(JSON.stringify(logEntry));
  }
  if (isNearLimit(rateLimitInfo)) {
    console.error(
      `[GitHub] Rate limit warning: ${rateLimitInfo.usagePercent}% used (${rateLimitInfo.remaining}/${rateLimitInfo.limit} remaining)`
    );
  }
});

// Intercept rate limit errors for observability
octokit.hook.error('request', (error, options) => {
  const status = (error as { status?: number }).status;
  const responseHeaders = (error as { response?: { headers?: Record<string, string> } }).response?.headers;

  if (status === 403 || status === 429) {
    const rateLimitInfo = parseRateLimitHeaders(responseHeaders ?? {});
    const logEntry = buildRateLimitLogEntry('github', String(options.url ?? ''), rateLimitInfo, true);
    console.error(JSON.stringify(logEntry));
  }
  throw error;
});
