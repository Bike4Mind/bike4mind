/**
 * GitHub Service
 *
 * Unified service for outbound GitHub API calls, supporting both:
 * - GitHub App authentication (preferred for production)
 * - Service Account PAT authentication (simpler setup)
 *
 * Follows the SlackClient pattern with:
 * - Factory methods for initialization
 * - Structured logging
 * - Rate limit tracking
 * - Health metrics
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Logger } from '@bike4mind/observability';
import {
  IOrgGitHubConnectionDocument,
  IRateLimitInfo,
  IHealthInfo,
  ITestConnectionResult,
  parseRateLimitHeaders,
  isNearLimit,
  buildRateLimitLogEntry,
  RateLimitInfo,
} from '@bike4mind/common';
import { orgGitHubConnectionRepository } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { decryptSecret, encryptSecret, isEncrypted } from '@server/security/secretEncryption';

const USER_AGENT = 'bike4mind-github-service/1.0';
const GITHUB_REQUEST_TIMEOUT_MS = 10000; // 10s — fail fast on hung connections (GitHub gateway timeout is ~11s)

/**
 * Parameters for creating a GitHub issue
 */
export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

/**
 * Parameters for updating a GitHub issue
 */
export interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
}

/**
 * Parameters for creating a label
 */
export interface CreateLabelParams {
  name: string;
  color: string;
  description?: string;
}

/**
 * GitHub issue representation
 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  closed_at?: string | null; // Available for closed issues
}

/**
 * GitHub label representation
 */
export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/**
 * GitHub repository representation
 */
export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

/**
 * GitHub comment representation
 */
export interface GitHubComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  author?: { login: string; type: string };
  authorAssociation?: string;
}

/**
 * GitHub pull request representation
 */
export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
}

/**
 * GitHub commit representation
 */
export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Options for listing merged pull requests
 */
export interface ListMergedPRsOptions {
  base: string;
  since: Date;
  perPage?: number;
}

/**
 * Options for listing commits
 */
export interface ListCommitsOptions {
  sha: string;
  since: Date;
  perPage?: number;
}

/**
 * Directory entry from GitHub Contents API
 */
export interface GitHubDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
}

/**
 * Code search result from GitHub Search API
 */
export interface GitHubCodeSearchResult {
  path: string;
  repository: string;
  textMatches: string[];
}

/**
 * Thrown when GitHub Code Search hits a 403/429 rate limit.
 * Callers can detect this to surface actionable guidance to the LLM
 * instead of silently returning empty results.
 */
export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * Coarse, non-sensitive classification of an auth-init failure. Logged so operators
 * can tell a misconfigured connection record ('missing-fields') apart from a
 * decryption / key-rotation failure ('decrypt-failed') WITHOUT ever exposing key
 * material or ciphertext structure. Both the reason codes and the messages carried
 * here are safe to log - decryption internals are stripped before this is thrown.
 */
export type GitHubAuthInitReason = 'missing-fields' | 'decrypt-failed';

export class GitHubAuthInitError extends Error {
  constructor(
    message: string,
    readonly reason: GitHubAuthInitReason
  ) {
    super(message);
    this.name = 'GitHubAuthInitError';
  }
}

export class GitHubService {
  private octokit: Octokit;
  private logger: Logger;
  private connectionId: string;
  private connectionType: 'github_app' | 'service_account';
  private allowedRepositories: string[];

  /**
   * Private constructor - use factory methods
   */
  private constructor(
    octokit: Octokit,
    logger: Logger,
    connectionId: string,
    connectionType: 'github_app' | 'service_account',
    allowedRepositories: string[]
  ) {
    this.octokit = octokit;
    this.logger = logger;
    this.connectionId = connectionId;
    this.connectionType = connectionType;
    this.allowedRepositories = allowedRepositories;
  }

  /**
   * Factory method to create a GitHubService for a specific organization
   */
  static async forOrganization(orgId: string, logger: Logger): Promise<GitHubService | null> {
    try {
      const connection = await orgGitHubConnectionRepository.findByOrganizationIdWithCredentials(orgId);
      if (!connection) {
        logger.warn('[GitHubService] No GitHub connection found for organization', { orgId });
        return null;
      }

      if (!connection.enabled) {
        logger.warn('[GitHubService] GitHub connection is disabled', { orgId });
        return null;
      }

      if (connection.suspendedAt) {
        logger.warn('[GitHubService] GitHub connection is suspended', {
          orgId,
          suspendedAt: connection.suspendedAt,
          suspendedBy: connection.suspendedBy,
        });
        return null;
      }

      return GitHubService.createFromConnection(connection, logger);
    } catch (error) {
      logger.error('[GitHubService] Error creating service for organization', { orgId, error });
      return null;
    }
  }

  /**
   * Factory method to create a GitHubService using the system default connection.
   *
   * Returns null for permanent config states (no connection / disabled / suspended /
   * missing SECRET_ENCRYPTION_KEY) - callers should swallow the message without retrying
   * since retries will never help.
   *
   * Throws for transient failures (DB error, or auth-init failure inside
   * createFromConnection) so SQS retries the message and routes it to the DLQ if retries
   * are exhausted.
   */
  static async forSystem(logger: Logger): Promise<GitHubService | null> {
    // DB failure is transient - propagates so callers retry rather than silently drop.
    const connection = await orgGitHubConnectionRepository.findSystemDefaultWithCredentials();

    if (!connection) {
      logger.warn('[GitHubService] No system default GitHub connection found');
      return null;
    }

    if (!connection.enabled) {
      logger.warn('[GitHubService] System default GitHub connection is disabled');
      return null;
    }

    if (connection.suspendedAt) {
      logger.warn('[GitHubService] System default GitHub connection is suspended', {
        suspendedAt: connection.suspendedAt,
        suspendedBy: connection.suspendedBy,
      });
      return null;
    }

    // Missing encryption key is a permanent deploy misconfiguration, not transient:
    // stored credentials can never be decrypted, so retrying will never succeed. Return
    // null (like disabled/suspended) so the SQS consumer swallows the message rather than
    // retrying it to the DLQ.
    if (!Config.SECRET_ENCRYPTION_KEY) {
      logger.error('[GitHubService] SECRET_ENCRYPTION_KEY not configured - permanent config error, not retrying');
      return null;
    }

    // DB failure (above) and auth-init failure (inside createFromConnection) remain
    // transient and propagate so the SQS consumer retries / escalates to the DLQ.
    return GitHubService.createFromConnection(connection, logger);
  }

  /**
   * Create a GitHubService from a connection document
   *
   * @throws Error if SECRET_ENCRYPTION_KEY is not configured (P0 security requirement)
   * @throws Error if Octokit authentication initialization fails
   */
  private static async createFromConnection(
    connection: IOrgGitHubConnectionDocument,
    logger: Logger
  ): Promise<GitHubService> {
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      // Fail hard: without this key, stored credentials cannot be decrypted
      const errorMsg = '[GitHubService] CRITICAL: SECRET_ENCRYPTION_KEY not configured. Cannot decrypt credentials.';
      logger.error(errorMsg);
      throw new Error('GitHub service configuration error. Please contact administrator.');
    }

    let octokit: Octokit;

    try {
      if (connection.connectionType === 'github_app') {
        octokit = await GitHubService.createOctokitForApp(connection, encryptionKey, logger);
      } else {
        octokit = GitHubService.createOctokitForPAT(connection, encryptionKey, logger);
      }
    } catch (error) {
      // Log a coarse, non-sensitive reason so operators can distinguish a misconfigured
      // connection record from a decryption/key-rotation failure. The reason codes and the
      // sanitized messages upstream never contain key material or ciphertext structure -
      // that is stripped in createOctokitFor{App,PAT} before the error reaches here.
      // Throw rather than return null: init failures are transient (network) or config
      // errors that callers should retry/escalate, not silently discard.
      logger.error('[GitHubService] Failed to initialize authentication', {
        connectionId: connection.id,
        connectionType: connection.connectionType,
        reason: error instanceof GitHubAuthInitError ? error.reason : 'unknown',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw new Error('[GitHubService] Failed to initialize GitHub authentication');
    }

    // Filter out empty/whitespace-only entries from whitelist to prevent bypass
    const filteredWhitelist = (connection.allowedRepositories || []).filter(repo => repo?.trim());

    const service = new GitHubService(octokit, logger, connection.id, connection.connectionType, filteredWhitelist);

    // Set up rate limit tracking hooks
    service.setupRateLimitHooks();

    return service;
  }

  /**
   * Create Octokit instance with GitHub App authentication
   *
   * @throws Error if decryption fails (sanitized message)
   */
  private static async createOctokitForApp(
    connection: IOrgGitHubConnectionDocument,
    encryptionKey: string,
    logger: Logger
  ): Promise<Octokit> {
    if (!connection.appId || !connection.installationId || !connection.privateKey) {
      throw new GitHubAuthInitError('GitHub App connection missing required fields', 'missing-fields');
    }

    // Decrypt the private key with sanitized error handling
    let privateKey = connection.privateKey;
    if (isEncrypted(privateKey)) {
      try {
        privateKey = decryptSecret(privateKey, encryptionKey);
      } catch {
        // Never expose decryption errors - they may reveal encryption structure
        throw new GitHubAuthInitError('Failed to decrypt credentials. Key may need rotation.', 'decrypt-failed');
      }
    }

    // Create custom cache for serverless token persistence
    const cache = GitHubService.createTokenCache(connection.id, encryptionKey, logger);

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: connection.appId,
        privateKey,
        installationId: connection.installationId,
        cache,
      },
      userAgent: USER_AGENT,
      request: {
        timeout: GITHUB_REQUEST_TIMEOUT_MS,
      },
    });

    return octokit;
  }

  /**
   * Create Octokit instance with PAT authentication
   *
   * @throws Error if decryption fails (sanitized message)
   */
  private static createOctokitForPAT(
    connection: IOrgGitHubConnectionDocument,
    encryptionKey: string,
    _logger: Logger
  ): Octokit {
    if (!connection.accessToken) {
      throw new GitHubAuthInitError('Service account connection missing credentials', 'missing-fields');
    }

    // Decrypt the token with sanitized error handling
    let token = connection.accessToken;
    if (isEncrypted(token)) {
      try {
        token = decryptSecret(token, encryptionKey);
      } catch {
        // Never expose decryption errors - they may reveal encryption structure
        throw new GitHubAuthInitError('Failed to decrypt credentials. Token may need rotation.', 'decrypt-failed');
      }
    }

    const octokit = new Octokit({
      auth: token,
      userAgent: USER_AGENT,
      request: {
        timeout: GITHUB_REQUEST_TIMEOUT_MS,
      },
    });

    return octokit;
  }

  /**
   * Create a custom token cache for serverless environments
   * Stores tokens in MongoDB to persist across Lambda invocations
   *
   * Uses optimistic concurrency control to prevent race conditions
   * when multiple Lambda invocations try to refresh the token simultaneously.
   */
  private static createTokenCache(connectionId: string, encryptionKey: string, logger: Logger) {
    return {
      async get(key: string): Promise<{ token: string; expiresAt: string } | undefined> {
        try {
          const conn = await orgGitHubConnectionRepository.findById(connectionId);
          if (conn?.cachedAccessToken && conn.tokenExpiresAt) {
            // Check if token is still valid (with 5 minute buffer)
            const expiresAt = new Date(conn.tokenExpiresAt);
            const buffer = 5 * 60 * 1000; // 5 minutes
            if (expiresAt.getTime() - buffer > Date.now()) {
              let token = conn.cachedAccessToken;
              if (isEncrypted(token)) {
                try {
                  token = decryptSecret(token, encryptionKey);
                } catch {
                  // Sanitize decryption errors
                  logger.warn('[GitHubService] Cached token decryption failed, will regenerate');
                  return undefined;
                }
              }
              return {
                token,
                expiresAt: expiresAt.toISOString(),
              };
            }
          }
          return undefined;
        } catch (error) {
          logger.warn('[GitHubService] Error reading cached token');
          return undefined;
        }
      },
      async set(key: string, value: { token: string; expiresAt: string }): Promise<void> {
        try {
          const encryptedToken = encryptSecret(value.token, encryptionKey);
          const newExpiresAt = new Date(value.expiresAt);

          // Atomic update in repository handles race condition check
          // No need for app-level pre-check - updateCachedToken uses conditional update
          await orgGitHubConnectionRepository.updateCachedToken(connectionId, encryptedToken, newExpiresAt);
        } catch (error) {
          logger.warn('[GitHubService] Error caching token');
        }
      },
    };
  }

  /**
   * Set up rate limit tracking hooks on the Octokit instance
   */
  private setupRateLimitHooks(): void {
    // Track rate limits on successful responses
    this.octokit.hook.after('request', async (response, options) => {
      const headers = (response as { headers?: Record<string, string> }).headers;
      if (!headers) return;

      const rateLimitInfo = parseRateLimitHeaders(headers);
      if (rateLimitInfo.remaining !== null) {
        // Update rate limit info in database
        await this.updateRateLimitFromInfo(rateLimitInfo);

        // Log rate limit status
        const logEntry = buildRateLimitLogEntry('github', String(options.url ?? ''), rateLimitInfo);
        this.logger.debug('[GitHubService] Rate limit status', logEntry);

        // Warn if near limit
        if (isNearLimit(rateLimitInfo)) {
          this.logger.warn('[GitHubService] Rate limit warning', {
            usagePercent: rateLimitInfo.usagePercent,
            remaining: rateLimitInfo.remaining,
            limit: rateLimitInfo.limit,
          });
        }
      }
    });

    // Track rate limit errors
    this.octokit.hook.error('request', async (error, options) => {
      const status = (error as { status?: number }).status;
      const responseHeaders = (error as { response?: { headers?: Record<string, string> } }).response?.headers;

      if (status === 403 || status === 429) {
        const rateLimitInfo = parseRateLimitHeaders(responseHeaders ?? {});
        const logEntry = buildRateLimitLogEntry('github', String(options.url ?? ''), rateLimitInfo, true);
        this.logger.error('[GitHubService] Rate limit exceeded', logEntry);
      }

      throw error;
    });
  }

  /**
   * Update rate limit info in the database
   */
  private async updateRateLimitFromInfo(info: RateLimitInfo): Promise<void> {
    if (info.limit === null || info.remaining === null) return;

    try {
      const rateLimitInfo: IRateLimitInfo = {
        rateLimitRemaining: info.remaining,
        rateLimitLimit: info.limit,
        rateLimitResetAt: info.resetAt || new Date(),
      };
      await orgGitHubConnectionRepository.updateRateLimitInfo(this.connectionId, rateLimitInfo);
    } catch (error) {
      this.logger.warn('[GitHubService] Error updating rate limit info', { error });
    }
  }

  /**
   * Update health metrics after an API call
   */
  private async updateHealthMetrics(latencyMs: number, error?: string): Promise<void> {
    try {
      const healthInfo: IHealthInfo = {
        lastUsedAt: new Date(),
        lastLatencyMs: latencyMs,
        lastError: error,
      };
      await orgGitHubConnectionRepository.updateHealthInfo(this.connectionId, healthInfo);
    } catch (err) {
      this.logger.warn('[GitHubService] Error updating health metrics', { error: err });
    }
  }

  /**
   * Normalize repository name for comparison.
   * Prevents whitelist bypass via malformed input (trailing spaces, case differences).
   */
  private normalizeRepo(repo: string): string {
    return repo.trim().toLowerCase();
  }

  /**
   * Check if a repository is allowed by the whitelist.
   * Fail-closed: empty whitelist blocks all repos. Uses normalized comparison to prevent bypass attacks.
   */
  private isRepoAllowed(repo: string): boolean {
    if (!this.allowedRepositories || this.allowedRepositories.length === 0) {
      this.logger.warn('[GitHubService] SECURITY: Repository access denied - no whitelist configured', {
        repo,
        connectionId: this.connectionId,
        reason: 'empty_whitelist',
      });
      return false;
    }
    const normalizedRepo = this.normalizeRepo(repo);
    const isAllowed = this.allowedRepositories.some(allowed => this.normalizeRepo(allowed) === normalizedRepo);

    if (!isAllowed) {
      this.logger.warn('[GitHubService] SECURITY: Repository access denied - not in whitelist', {
        repo,
        normalizedRepo,
        connectionId: this.connectionId,
        whitelistCount: this.allowedRepositories.length,
        reason: 'not_in_whitelist',
      });
    }
    return isAllowed;
  }

  /**
   * Validate GitHub owner/org name format.
   * GitHub usernames: 1-39 chars, alphanumeric and hyphens, no leading/trailing/consecutive hyphens.
   */
  private isValidGitHubOwner(owner: string): boolean {
    // GitHub username constraints
    const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
    return ownerRegex.test(owner);
  }

  /**
   * Validate GitHub repository name format.
   * Repo names: 1-100 chars, alphanumeric, hyphens, underscores, periods.
   */
  private isValidGitHubRepoName(repoName: string): boolean {
    // GitHub repo name constraints (simplified - allows alphanumeric, hyphen, underscore, period)
    const repoRegex = /^[a-zA-Z0-9._-]{1,100}$/;
    return repoRegex.test(repoName);
  }

  /**
   * Parse owner and repo from a full repo name.
   * Validates both are non-empty and match GitHub naming constraints.
   */
  private parseRepo(repo: string): { owner: string; repo: string } {
    const parts = repo.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid repository format: ${repo}. Expected owner/repo`);
    }
    const [owner, repoName] = parts;
    if (!owner?.trim() || !repoName?.trim()) {
      throw new Error(`Invalid repository format: ${repo}. Owner and repo name cannot be empty`);
    }
    const trimmedOwner = owner.trim();
    const trimmedRepo = repoName.trim();
    if (!this.isValidGitHubOwner(trimmedOwner)) {
      throw new Error(`Invalid GitHub owner/org name: ${trimmedOwner}`);
    }
    if (!this.isValidGitHubRepoName(trimmedRepo)) {
      throw new Error(`Invalid GitHub repository name: ${trimmedRepo}`);
    }
    return { owner: trimmedOwner, repo: trimmedRepo };
  }

  /**
   * Execute an API call with timing and error handling
   */
  private async executeWithMetrics<T>(operation: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    try {
      const result = await operation();
      await this.updateHealthMetrics(Date.now() - startTime);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateHealthMetrics(Date.now() - startTime, errorMessage);
      throw error;
    }
  }

  // ============================================
  // Issue Operations
  // ============================================

  /**
   * Sanitize search query to prevent injection of GitHub search qualifiers
   * Only strips qualifiers that could escape the intended repository scope.
   * All other qualifiers (is:, label:, closed:, etc.) are safe because
   * the repo: qualifier is always prepended by searchIssues().
   */
  private sanitizeSearchQuery(query: string): string {
    // Only strip qualifiers that could escape the intended repository scope
    const repoEscapingQualifiers = /\b(repo|org|user):(?:"[^"]*"|[^\s]*)/gi;
    return query.replace(repoEscapingQualifiers, '').trim();
  }

  /**
   * Search for issues in a repository
   */
  async searchIssues(repo: string, query: string): Promise<GitHubIssue[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);
    const sanitizedQuery = this.sanitizeSearchQuery(query);

    return this.executeWithMetrics(async () => {
      const fullQuery = `repo:${owner}/${repoName} ${sanitizedQuery}`;
      const result = await this.octokit.search.issuesAndPullRequests({
        q: fullQuery,
        per_page: 100,
      });

      return result.data.items
        .filter(item => !item.pull_request) // Exclude PRs
        .map(issue => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          html_url: issue.html_url,
          labels: issue.labels.map(l => ({
            name: typeof l === 'string' ? l : l.name || '',
            color: typeof l === 'string' ? '' : l.color || '',
          })),
          assignees: issue.assignees?.map(a => ({ login: a.login })) || [],
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at ?? null,
        }));
    });
  }

  /**
   * List issues in a repository using the Issues API (not Search API)
   * Use this for listing issues with specific filters like state, labels, since date
   * For complex queries, use searchIssues() instead
   */
  async listIssues(
    repo: string,
    params: {
      state?: 'open' | 'closed' | 'all';
      labels?: string; // Comma-separated list of label names
      since?: string; // ISO 8601 date - only issues updated at or after this time
      per_page?: number;
      page?: number;
      sort?: 'created' | 'updated' | 'comments';
      direction?: 'asc' | 'desc';
    } = {}
  ): Promise<GitHubIssue[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const result = await this.octokit.issues.listForRepo({
        owner,
        repo: repoName,
        state: params.state || 'open',
        labels: params.labels,
        since: params.since,
        per_page: params.per_page || 100,
        page: params.page || 1,
        sort: params.sort || 'updated',
        direction: params.direction || 'desc',
      });

      return result.data
        .filter(item => !item.pull_request) // Exclude PRs
        .map(issue => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          html_url: issue.html_url,
          labels: issue.labels.map(l => ({
            name: typeof l === 'string' ? l : l.name || '',
            color: typeof l === 'string' ? '' : l.color || '',
          })),
          assignees: issue.assignees?.map(a => ({ login: a.login })) || [],
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at ?? null,
        }));
    });
  }

  /**
   * Create a new issue
   */
  async createIssue(repo: string, params: CreateIssueParams): Promise<GitHubIssue | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const result = await this.octokit.issues.create({
        owner,
        repo: repoName,
        title: params.title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
      });

      this.logger.info('[GitHubService] Created issue', {
        repo,
        issueNumber: result.data.number,
        title: params.title,
      });

      return {
        number: result.data.number,
        title: result.data.title,
        body: result.data.body ?? null,
        state: result.data.state,
        html_url: result.data.html_url,
        labels: result.data.labels.map(l => ({
          name: typeof l === 'string' ? l : l.name || '',
          color: typeof l === 'string' ? '' : l.color || '',
        })),
        assignees: result.data.assignees?.map(a => ({ login: a.login })) || [],
        created_at: result.data.created_at,
        updated_at: result.data.updated_at,
        closed_at: result.data.closed_at ?? null,
      };
    });
  }

  /**
   * Get an issue by number
   */
  async getIssue(repo: string, issueNumber: number): Promise<GitHubIssue | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      try {
        const result = await this.octokit.issues.get({
          owner,
          repo: repoName,
          issue_number: issueNumber,
        });

        return {
          number: result.data.number,
          title: result.data.title,
          body: result.data.body ?? null,
          state: result.data.state,
          html_url: result.data.html_url,
          labels: result.data.labels.map(l => ({
            name: typeof l === 'string' ? l : l.name || '',
            color: typeof l === 'string' ? '' : l.color || '',
          })),
          assignees: result.data.assignees?.map(a => ({ login: a.login })) || [],
          created_at: result.data.created_at,
          updated_at: result.data.updated_at,
          closed_at: result.data.closed_at ?? null,
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return null;
        }
        throw error;
      }
    });
  }

  /**
   * Update an existing issue
   */
  async updateIssue(repo: string, issueNumber: number, params: UpdateIssueParams): Promise<GitHubIssue | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const result = await this.octokit.issues.update({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        title: params.title,
        body: params.body,
        state: params.state,
        labels: params.labels,
        assignees: params.assignees,
      });

      this.logger.info('[GitHubService] Updated issue', {
        repo,
        issueNumber,
      });

      return {
        number: result.data.number,
        title: result.data.title,
        body: result.data.body ?? null,
        state: result.data.state,
        html_url: result.data.html_url,
        labels: result.data.labels.map(l => ({
          name: typeof l === 'string' ? l : l.name || '',
          color: typeof l === 'string' ? '' : l.color || '',
        })),
        assignees: result.data.assignees?.map(a => ({ login: a.login })) || [],
        created_at: result.data.created_at,
        updated_at: result.data.updated_at,
        closed_at: result.data.closed_at ?? null,
      };
    });
  }

  /**
   * Add a comment to an issue
   */
  async addIssueComment(repo: string, issueNumber: number, body: string): Promise<GitHubComment | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const result = await this.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body,
      });

      this.logger.info('[GitHubService] Added comment to issue', {
        repo,
        issueNumber,
      });

      return {
        id: result.data.id,
        body: result.data.body || '',
        html_url: result.data.html_url,
        created_at: result.data.created_at,
      };
    });
  }

  /**
   * List comments on an issue, filtering out bot comments.
   * Returns up to `limit` most recent human comments, sorted newest-first.
   */
  async listIssueComments(repo: string, issueNumber: number, limit = 10): Promise<GitHubComment[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const result = await this.octokit.issues.listComments({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        per_page: 100,
      });

      const humanComments = result.data
        .filter(c => c.user?.type !== 'Bot')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit)
        .map(c => ({
          id: c.id,
          body: c.body || '',
          html_url: c.html_url,
          created_at: c.created_at,
          author: c.user ? { login: c.user.login, type: c.user.type || 'User' } : undefined,
          authorAssociation: c.author_association,
        }));

      this.logger.info('[GitHubService] Listed issue comments', {
        repo,
        issueNumber,
        total: result.data.length,
        humanCount: humanComments.length,
      });

      return humanComments;
    });
  }

  /**
   * Check whether any comment on an issue contains a given marker string.
   * Unlike listIssueComments, this includes bot-authored comments so it can
   * detect markers placed by prior automation runs (e.g., escalation HTML
   * comments like `<!-- sre-recurrence-escalation -->`).
   *
   * Returns true if at least one comment's body includes the marker.
   */
  async hasCommentWithMarker(repo: string, issueNumber: number, marker: string): Promise<boolean> {
    if (!this.isRepoAllowed(repo)) return false;

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
        owner,
        repo: repoName,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.some(c => (c.body || '').includes(marker));
    });
  }

  /**
   * Close an issue
   */
  async closeIssue(repo: string, issueNumber: number): Promise<GitHubIssue | null> {
    return this.updateIssue(repo, issueNumber, { state: 'closed' });
  }

  // ============================================
  // Label Operations
  // ============================================

  /**
   * List labels in a repository
   */
  async listLabels(repo: string): Promise<GitHubLabel[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const allLabels = await this.octokit.paginate(this.octokit.issues.listLabelsForRepo, {
        owner,
        repo: repoName,
        per_page: 100,
      });

      return allLabels.map(label => ({
        id: label.id,
        name: label.name,
        color: label.color,
        description: label.description,
      }));
    });
  }

  /**
   * Create a new label
   */
  async createLabel(repo: string, params: CreateLabelParams): Promise<GitHubLabel | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      try {
        const result = await this.octokit.issues.createLabel({
          owner,
          repo: repoName,
          name: params.name,
          color: params.color.replace('#', ''), // Remove # prefix if present
          description: params.description,
        });

        this.logger.info('[GitHubService] Created label', {
          repo,
          label: params.name,
        });

        return {
          id: result.data.id,
          name: result.data.name,
          color: result.data.color,
          description: result.data.description,
        };
      } catch (error) {
        const status = (error as { status?: number }).status;
        const message = error instanceof Error ? error.message : String(error);

        // Handle "already_exists" error (422) - label exists but wasn't found due to case sensitivity or pagination
        if (status === 422 && message.includes('already_exists')) {
          this.logger.info('[GitHubService] Label already exists, fetching it', {
            repo,
            label: params.name,
          });

          // Try to get the existing label (case-insensitive search)
          try {
            const result = await this.octokit.issues.getLabel({
              owner,
              repo: repoName,
              name: params.name,
            });

            return {
              id: result.data.id,
              name: result.data.name,
              color: result.data.color,
              description: result.data.description,
            };
          } catch {
            // If we can't fetch it, log and continue
            this.logger.warn('[GitHubService] Label exists but could not fetch it', {
              repo,
              label: params.name,
            });
          }
        }

        // Log the specific error for debugging
        this.logger.error('[GitHubService] Failed to create label', {
          repo,
          label: params.name,
          status,
          error: message,
        });

        // Return null to indicate failure (don't throw)
        return null;
      }
    });
  }

  /**
   * Ensure a label exists, creating it if necessary
   */
  async ensureLabelExists(repo: string, params: CreateLabelParams): Promise<GitHubLabel | null> {
    const labels = await this.listLabels(repo);
    // GitHub labels are case-insensitive, so do case-insensitive comparison
    const existing = labels.find(l => l.name.toLowerCase() === params.name.toLowerCase());

    if (existing) {
      return existing;
    }

    return this.createLabel(repo, params);
  }

  // ============================================
  // Repository Operations
  // ============================================

  /**
   * Get repository information
   */
  async getRepository(repo: string): Promise<GitHubRepository | null> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      try {
        const result = await this.octokit.repos.get({
          owner,
          repo: repoName,
        });

        return {
          id: result.data.id,
          name: result.data.name,
          full_name: result.data.full_name,
          private: result.data.private,
          html_url: result.data.html_url,
          description: result.data.description,
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return null;
        }
        throw error;
      }
    });
  }

  /**
   * List accessible repositories. Filters by whitelist if configured (unless skipWhitelistFilter is true).
   * @param options.skipWhitelistFilter - If true, returns ALL accessible repos (for admin configuration UI)
   */
  async listRepositories(options?: { skipWhitelistFilter?: boolean }): Promise<GitHubRepository[]> {
    return this.executeWithMetrics(async () => {
      // For GitHub App, list installation repositories
      // For PAT, list user's repositories
      const result =
        this.connectionType === 'github_app'
          ? await this.octokit.apps.listReposAccessibleToInstallation({ per_page: 100 })
          : await this.octokit.repos.listForAuthenticatedUser({ per_page: 100 });

      const repos = 'repositories' in result.data ? result.data.repositories : result.data;

      // Filter by whitelist unless explicitly skipped (for admin config UI)
      const filteredRepos = options?.skipWhitelistFilter
        ? repos
        : repos.filter((repo: { full_name: string }) => this.isRepoAllowed(repo.full_name));

      return filteredRepos.map(
        (repo: {
          id: number;
          name: string;
          full_name: string;
          private: boolean;
          html_url: string;
          description: string | null;
        }) => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          html_url: repo.html_url,
          description: repo.description,
        })
      );
    });
  }

  // ============================================
  // Pull Request Operations
  // ============================================

  /**
   * List merged pull requests for a repository
   * Fetches closed PRs and filters by merged_at date
   */
  async listMergedPullRequests(repo: string, options: ListMergedPRsOptions): Promise<GitHubPullRequest[]> {
    if (!this.isRepoAllowed(repo)) {
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const allPRs = await this.octokit.paginate(this.octokit.pulls.list, {
        owner,
        repo: repoName,
        state: 'closed',
        base: options.base,
        sort: 'updated',
        direction: 'desc',
        per_page: options.perPage || 100,
      });

      // Filter to PRs merged after the since date
      return allPRs
        .filter(pr => {
          if (!pr.merged_at) return false;
          return new Date(pr.merged_at) >= options.since;
        })
        .map(pr => ({
          number: pr.number,
          title: pr.title,
          body: pr.body ?? null,
          state: pr.state,
          html_url: pr.html_url,
          merged_at: pr.merged_at ?? null,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          user: pr.user ? { login: pr.user.login } : null,
          labels: pr.labels.map(l => ({ name: l.name || '' })),
        }));
    });
  }

  // ============================================
  // Commit Operations
  // ============================================

  /**
   * List commits for a repository branch since a given date
   */
  async listCommits(repo: string, options: ListCommitsOptions): Promise<GitHubCommit[]> {
    if (!this.isRepoAllowed(repo)) {
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      const allCommits = await this.octokit.paginate(this.octokit.repos.listCommits, {
        owner,
        repo: repoName,
        sha: options.sha,
        since: options.since.toISOString(),
        per_page: options.perPage || 100,
      });

      return allCommits.map(c => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message,
        author: c.commit.author?.name || 'unknown',
        date: c.commit.author?.date || '',
      }));
    });
  }

  // ============================================
  // File Content Operations
  // ============================================

  /**
   * Get file content from a repository
   * Returns the decoded text content, or null if the file doesn't exist
   */
  async getFileContent(repo: string, path: string, ref?: string): Promise<string | null> {
    if (!this.isRepoAllowed(repo)) {
      return null;
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      try {
        const result = await this.octokit.repos.getContent({
          owner,
          repo: repoName,
          path,
          ref,
        });

        // getContent returns a file object when path is a file
        const data = result.data;
        if ('content' in data && data.encoding === 'base64') {
          return Buffer.from(data.content, 'base64').toString('utf-8');
        }

        return null;
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return null;
        }
        throw error;
      }
    });
  }

  /**
   * List directory contents from a repository
   * Returns an array of directory entries, or [] if the path doesn't exist or is a file
   */
  async listDirectoryContents(repo: string, path: string, ref?: string): Promise<GitHubDirectoryEntry[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    return this.executeWithMetrics(async () => {
      try {
        const result = await this.octokit.repos.getContent({
          owner,
          repo: repoName,
          path,
          ref,
        });

        if (!Array.isArray(result.data)) {
          this.logger.warn('[GitHubService] listDirectoryContents called with a file path, returning []', {
            repo,
            path,
          });
          return [];
        }

        if (result.data.length === 1000) {
          this.logger.warn('[GitHubService] Directory listing may be truncated (1000 entries)', {
            repo,
            path,
          });
        }

        return result.data.map(entry => ({
          name: entry.name,
          path: entry.path,
          type: entry.type as 'file' | 'dir' | 'symlink' | 'submodule',
          size: entry.size,
        }));
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return [];
        }
        throw error;
      }
    });
  }

  /**
   * Search for code in a repository
   * Returns matching file paths and text fragments
   * Note: GitHub code search has a strict 10 req/min rate limit
   */
  async searchCode(repo: string, query: string): Promise<GitHubCodeSearchResult[]> {
    if (!this.isRepoAllowed(repo)) {
      // Security logging handled by isRepoAllowed
      return [];
    }

    const { owner, repo: repoName } = this.parseRepo(repo);
    const sanitizedQuery = this.sanitizeSearchQuery(query);

    return this.executeWithMetrics(async () => {
      try {
        const fullQuery = `repo:${owner}/${repoName} ${sanitizedQuery}`;
        const result = await this.octokit.search.code({
          q: fullQuery,
          per_page: 10,
          headers: {
            accept: 'application/vnd.github.text-match+json',
          },
        });

        return result.data.items.map(item => ({
          path: item.path,
          repository: item.repository.full_name,
          // Octokit types omit text_matches - only present with the text-match+json Accept header
          textMatches: ((item as unknown as { text_matches?: Array<{ fragment: string }> }).text_matches || []).map(
            m => m.fragment
          ),
        }));
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 429) {
          this.logger.warn('[GitHubService] Code search rate limit reached', { repo, query: sanitizedQuery });
          throw new GitHubRateLimitError(`GitHub Code Search rate limited (HTTP ${status})`);
        }
        if (status === 422) {
          this.logger.warn('[GitHubService] Code search validation error', { repo, query: sanitizedQuery });
          return [];
        }
        throw error;
      }
    });
  }

  /**
   * Trigger a repository_dispatch event (for GitHub Actions workflows)
   */
  async createDispatchEvent(repo: string, eventType: string, clientPayload: Record<string, unknown>): Promise<void> {
    if (!this.isRepoAllowed(repo)) {
      throw new Error(`Repository ${repo} not in allowlist`);
    }

    const { owner, repo: repoName } = this.parseRepo(repo);

    await this.executeWithMetrics(async () => {
      await this.octokit.repos.createDispatchEvent({
        owner,
        repo: repoName,
        event_type: eventType,
        client_payload: clientPayload,
      });

      this.logger.info('[GitHubService] Created dispatch event', {
        repo,
        eventType,
      });
    });
  }

  // ============================================
  // Utility / Health
  // ============================================

  /**
   * Test the connection and return status
   */
  async testConnection(): Promise<ITestConnectionResult> {
    const startTime = Date.now();

    try {
      if (this.connectionType === 'github_app') {
        // For GitHub App, get the authenticated app
        const result = await this.octokit.apps.getAuthenticated();
        const latencyMs = Date.now() - startTime;

        await this.updateHealthMetrics(latencyMs);

        const appData = result.data;
        return {
          success: true,
          type: 'app',
          appName: appData?.name || 'Unknown App',
          login: appData?.slug || appData?.name || 'unknown',
          latencyMs,
        };
      } else {
        // For PAT, get the authenticated user
        const result = await this.octokit.users.getAuthenticated();
        const latencyMs = Date.now() - startTime;

        await this.updateHealthMetrics(latencyMs);

        return {
          success: true,
          type: 'user',
          login: result.data?.login || 'unknown',
          latencyMs,
        };
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const userFriendlyError = this.formatGitHubError(error);

      await this.updateHealthMetrics(latencyMs, userFriendlyError);

      return {
        success: false,
        error: userFriendlyError,
        latencyMs,
      };
    }
  }

  /**
   * Format GitHub API errors into user-friendly messages
   */
  private formatGitHubError(error: unknown): string {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);

    // Map common HTTP status codes to user-friendly messages
    switch (status) {
      case 401:
        if (this.connectionType === 'github_app') {
          return 'Authentication failed. The private key may be invalid or the GitHub App may have been deleted.';
        }
        return 'Authentication failed. The Personal Access Token is invalid or has been revoked.';

      case 403:
        if (message.toLowerCase().includes('rate limit')) {
          return 'GitHub API rate limit exceeded. Please wait before making more requests.';
        }
        if (message.toLowerCase().includes('suspended')) {
          return 'The GitHub App installation has been suspended. Please check your GitHub App settings.';
        }
        return 'Access denied. The token may lack required permissions or the resource may be restricted.';

      case 404:
        if (this.connectionType === 'github_app') {
          return 'GitHub App or installation not found. The app may have been uninstalled or the installation ID is incorrect.';
        }
        return 'Resource not found. The token may not have access to the requested resource.';

      case 422:
        return `GitHub validation error: ${message}`;

      default:
        // For other errors, include the status code if available
        if (status) {
          return `GitHub API error (${status}): ${message}`;
        }
        return message || 'An unexpected error occurred while connecting to GitHub.';
    }
  }

  /**
   * Get the authenticated entity (user or app)
   */
  async getAuthenticatedEntity(): Promise<{ type: 'user' | 'app'; login: string; id: number } | null> {
    try {
      if (this.connectionType === 'github_app') {
        const result = await this.octokit.apps.getAuthenticated();
        const appData = result.data;
        if (!appData) {
          return null;
        }
        return {
          type: 'app',
          login: appData.slug || appData.name,
          id: appData.id,
        };
      } else {
        const result = await this.octokit.users.getAuthenticated();
        const userData = result.data;
        if (!userData) {
          return null;
        }
        return {
          type: 'user',
          login: userData.login,
          id: userData.id,
        };
      }
    } catch (error) {
      this.logger.error('[GitHubService] Error getting authenticated entity', { error });
      return null;
    }
  }

  /**
   * Check the current rate limit status
   */
  async checkRateLimit(): Promise<RateLimitInfo> {
    const result = await this.octokit.rateLimit.get();
    const core = result.data.resources.core;

    return {
      limit: core.limit,
      remaining: core.remaining,
      resetAt: new Date(core.reset * 1000),
      retryAfterMs: null,
      usagePercent: Math.round(((core.limit - core.remaining) / core.limit) * 100),
    };
  }
}
