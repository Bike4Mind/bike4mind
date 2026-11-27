import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies using vi.hoisted
const { mockOctokit, mockRepository, mockConfig, mockDecryptToken, mockEncryptSecret, mockIsEncrypted, mockLogger } =
  vi.hoisted(() => ({
    mockOctokit: {
      paginate: vi.fn(),
      request: vi.fn(),
      pulls: {
        get: vi.fn(),
        list: vi.fn(),
      },
      issues: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(),
        listForRepo: vi.fn(),
        listLabelsForRepo: vi.fn(),
        createLabel: vi.fn(),
      },
      search: {
        issuesAndPullRequests: vi.fn(),
        code: vi.fn(),
      },
      repos: {
        get: vi.fn(),
        getContent: vi.fn(),
        listForAuthenticatedUser: vi.fn(),
        listCommits: vi.fn(),
      },
      apps: {
        getAuthenticated: vi.fn(),
        listReposAccessibleToInstallation: vi.fn(),
      },
      users: {
        getAuthenticated: vi.fn(),
        getByUsername: vi.fn(),
      },
      rateLimit: {
        get: vi.fn(),
      },
      hook: {
        after: vi.fn(),
        error: vi.fn(),
      },
    },
    mockRepository: {
      findByOrganizationIdWithCredentials: vi.fn(),
      findSystemDefaultWithCredentials: vi.fn(),
      findById: vi.fn(),
      updateRateLimitInfo: vi.fn(),
      updateHealthInfo: vi.fn(),
      updateCachedToken: vi.fn(),
    },
    mockConfig: {
      SECRET_ENCRYPTION_KEY: 'a'.repeat(64), // Valid 64 hex char key
    },
    mockDecryptToken: vi.fn((val: string) => val),
    mockEncryptSecret: vi.fn((val: string) => `encrypted:${val}`),
    mockIsEncrypted: vi.fn(() => false),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));

// Mock Octokit
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(function () {
    return mockOctokit;
  }),
}));

// Mock auth-app
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

// Mock database repository
vi.mock('@bike4mind/database', () => ({
  orgGitHubConnectionRepository: mockRepository,
}));

// Mock config
vi.mock('../utils/config', () => ({
  Config: mockConfig,
}));

// Mock secret encryption
vi.mock('../security/secretEncryption', () => ({
  encryptSecret: mockEncryptSecret,
  isEncrypted: mockIsEncrypted,
}));

// Mock token encryption (rotation-aware decrypt: current key, then previous)
vi.mock('../security/tokenEncryption', () => ({
  decryptToken: mockDecryptToken,
}));

// Mock @bike4mind/common
vi.mock('@bike4mind/common', async importOriginal => ({
  // Real header parsing, so rate-limit classification is exercised end to end.
  parseRateLimitHeaders: (await importOriginal<typeof import('@bike4mind/common')>()).parseRateLimitHeaders,
  isNearLimit: vi.fn(() => false),
  buildRateLimitLogEntry: vi.fn(() => ({})),
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));

import { GitHubService, GitHubRateLimitError, GitHubRepoNotAllowedError, GitHubRequestError } from './githubService';
import { Logger } from '@bike4mind/observability';
import type { ITestConnectionFailure, ITestConnectionSuccess } from '@bike4mind/common';

describe('GitHubService', () => {
  const mockConnection = {
    id: 'conn-123',
    organizationId: 'org-456',
    connectionType: 'service_account' as const,
    accessToken: 'test-token',
    // Default to 'owner/repo' for tests that use this repo
    allowedRepositories: ['owner/repo'],
    enabled: true,
    isSystemDefault: false,
    connectedBy: 'user-789',
    connectedAt: new Date(),
    suspendedAt: undefined,
    suspendedBy: undefined,
  };

  const mockAppConnection = {
    ...mockConnection,
    connectionType: 'github_app' as const,
    appId: 'app-123',
    installationId: 'install-456',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    accessToken: undefined,
    // Include allowed repos for GitHub App tests
    allowedRepositories: ['owner/repo', 'owner/repo1'],
  };

  const logger = new Logger({ metadata: { component: 'test' } });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);
    // Re-apply paginate mock after clearAllMocks
    mockOctokit.paginate.mockImplementation(
      async (method: (...args: unknown[]) => Promise<{ data: unknown[] }>, params: Record<string, unknown>) => {
        const result = await method(params);
        return result.data;
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Factory Methods', () => {
    describe('forOrganization', () => {
      it('should return null if no connection found', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(null);

        const service = await GitHubService.forOrganization('org-123', logger);

        expect(service).toBeNull();
        expect(mockRepository.findByOrganizationIdWithCredentials).toHaveBeenCalledWith('org-123');
      });

      it('should return null if connection is disabled', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          enabled: false,
        });

        const service = await GitHubService.forOrganization('org-123', logger);

        expect(service).toBeNull();
      });

      it('should return null if connection is suspended', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          suspendedAt: new Date(),
          suspendedBy: 'GitHub',
        });

        const service = await GitHubService.forOrganization('org-123', logger);

        expect(service).toBeNull();
      });

      it('should return service for valid PAT connection', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);

        const service = await GitHubService.forOrganization('org-123', logger);

        expect(service).not.toBeNull();
        expect(service).toBeInstanceOf(GitHubService);
      });

      it('should throw error if SECRET_ENCRYPTION_KEY is not configured', async () => {
        mockConfig.SECRET_ENCRYPTION_KEY = '';
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);

        // Throws instead of returning null for security
        await expect(GitHubService.forOrganization('org-123', logger)).rejects.toThrow(
          'GitHub service configuration error'
        );
      });
    });

    describe('Octokit request log', () => {
      it.each([
        ['PAT', mockConnection],
        ['GitHub App', mockAppConnection],
      ])('%s client logs an access-loss 404 from Octokit at warn, not error', async (_, connection) => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(connection);
        const { Octokit } = await import('@octokit/rest');

        await GitHubService.forOrganization('org-123', logger);
        const { log } = vi.mocked(Octokit).mock.lastCall![0] as { log: { error: (msg: string) => void } };
        log.error('GET /repos/owner/repo - 404 with id ABC in 12ms');

        expect(mockLogger.warn).toHaveBeenCalled();
        expect(mockLogger.error).not.toHaveBeenCalled();
      });
    });

    describe('forSystem', () => {
      it('should return null if no system default found', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue(null);

        const service = await GitHubService.forSystem(logger);

        expect(service).toBeNull();
        expect(mockRepository.findSystemDefaultWithCredentials).toHaveBeenCalled();
      });

      it('should return null if system default connection is disabled', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
          enabled: false,
        });

        const service = await GitHubService.forSystem(logger);

        expect(service).toBeNull();
      });

      it('should return null if system default connection is suspended', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
          suspendedAt: new Date(),
          suspendedBy: 'admin-user',
        });

        const service = await GitHubService.forSystem(logger);

        expect(service).toBeNull();
      });

      it('should return service for valid system default connection', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });

        const service = await GitHubService.forSystem(logger);

        expect(service).not.toBeNull();
      });

      it('should throw on DB error so the caller can retry (transient failure)', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockRejectedValue(new Error('DB connection failed'));

        await expect(GitHubService.forSystem(logger)).rejects.toThrow('DB connection failed');
      });

      it('should return null when SECRET_ENCRYPTION_KEY is not configured (permanent config error)', async () => {
        mockConfig.SECRET_ENCRYPTION_KEY = '';
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });

        // Missing key is a permanent deploy misconfiguration - forSystem returns null so
        // the SQS consumer swallows the message instead of retrying.
        await expect(GitHubService.forSystem(logger)).resolves.toBeNull();
        // ...and logs the permanent-config reason so the swallow is not silent.
        expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('SECRET_ENCRYPTION_KEY not configured'));
      });

      it('should throw on auth init failure so the caller can retry (transient failure)', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });
        // Mark the token as encrypted so decryptToken is actually called,
        // then make decryption blow up to simulate an auth init failure.
        mockIsEncrypted.mockReturnValueOnce(true);
        mockDecryptToken.mockImplementationOnce(() => {
          throw new Error('decryption failed');
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow(
          '[GitHubService] Failed to initialize GitHub authentication'
        );
      });

      // Regression: the auth-init catch used to discard the underlying error, making
      // github_app failures undebuggable. It must now log a coarse, non-sensitive reason
      // that distinguishes a misconfigured record from a decryption/key-rotation failure -
      // without leaking key material or ciphertext structure.
      it('should log reason "decrypt-failed" when decryption throws', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });
        mockIsEncrypted.mockReturnValueOnce(true);
        mockDecryptToken.mockImplementationOnce(() => {
          throw new Error('decryption failed');
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow(
          '[GitHubService] Failed to initialize GitHub authentication'
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          '[GitHubService] Failed to initialize authentication',
          expect.objectContaining({
            reason: 'decrypt-failed',
            detail: 'Failed to decrypt credentials. Token may need rotation.',
          })
        );
      });

      // Regression (LiveOps/SRE outage): a github_app private key encrypted under a
      // pre-rotation key must still authenticate. The auth-init path must decrypt via
      // decryptToken (current key, then SECRET_ENCRYPTION_KEY_PREVIOUS), mirroring the
      // GitHub webhook paths - not raw decryptSecret with the current key only.
      it('should recover a github_app credential via the key-rotation fallback', async () => {
        const encryptedPrivateKey = 'aa'.repeat(16) + ':' + 'bb'.repeat(16) + ':deadbeef';
        const decryptedPem = '-----BEGIN RSA PRIVATE KEY-----\nrecovered\n-----END RSA PRIVATE KEY-----';
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockAppConnection,
          isSystemDefault: true,
          privateKey: encryptedPrivateKey,
        });
        // Ciphertext looks encrypted; decryptToken succeeds (as it would using the previous key).
        mockIsEncrypted.mockReturnValue(true);
        mockDecryptToken.mockReturnValue(decryptedPem);

        const service = await GitHubService.forSystem(logger);

        expect(service).not.toBeNull();
        expect(mockDecryptToken).toHaveBeenCalledWith(encryptedPrivateKey);
      });

      it('should log reason "missing-fields" when a github_app connection is missing required fields', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockAppConnection,
          isSystemDefault: true,
          privateKey: undefined,
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow(
          '[GitHubService] Failed to initialize GitHub authentication'
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          '[GitHubService] Failed to initialize authentication',
          expect.objectContaining({
            reason: 'missing-fields',
            detail: 'GitHub App connection missing required fields',
          })
        );
      });

      it('should not leak the decrypted key material or ciphertext into the auth-init log', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });
        mockIsEncrypted.mockReturnValueOnce(true);
        mockDecryptToken.mockImplementationOnce(() => {
          throw new Error('cipher gcm tag mismatch: 0xDEADBEEF iv=abcdef');
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow();
        const authInitCall = mockLogger.error.mock.calls.find(
          ([msg]) => msg === '[GitHubService] Failed to initialize authentication'
        );
        expect(authInitCall).toBeDefined();
        expect(JSON.stringify(authInitCall![1])).not.toContain('DEADBEEF');
      });
    });
  });

  describe('Issue Operations', () => {
    let service: GitHubService;

    beforeEach(async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      service = (await GitHubService.forOrganization('org-123', logger))!;
    });

    describe('createIssue', () => {
      it('should create an issue successfully', async () => {
        const mockIssueResponse = {
          data: {
            number: 1,
            title: 'Test Issue',
            body: 'Test body',
            state: 'open',
            html_url: 'https://github.com/owner/repo/issues/1',
            labels: [{ name: 'bug', color: 'ff0000' }],
            assignees: [{ login: 'user1' }],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        };
        mockOctokit.issues.create.mockResolvedValue(mockIssueResponse);

        const result = await service.createIssue('owner/repo', {
          title: 'Test Issue',
          body: 'Test body',
          labels: ['bug'],
        });

        expect(result).not.toBeNull();
        expect(result!.number).toBe(1);
        expect(result!.title).toBe('Test Issue');
        expect(mockOctokit.issues.create).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          title: 'Test Issue',
          body: 'Test body',
          labels: ['bug'],
          assignees: undefined,
        });
      });

      it('should return null for repo not in allowlist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['allowed/repo'],
        });
        service = (await GitHubService.forOrganization('org-123', logger))!;

        const result = await service.createIssue('other/repo', {
          title: 'Test Issue',
        });

        expect(result).toBeNull();
        expect(mockOctokit.issues.create).not.toHaveBeenCalled();
      });
    });

    describe('getIssue', () => {
      it('should get an issue successfully', async () => {
        const mockIssueResponse = {
          data: {
            number: 1,
            title: 'Test Issue',
            body: 'Test body',
            state: 'open',
            html_url: 'https://github.com/owner/repo/issues/1',
            labels: [],
            assignees: [],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        };
        mockOctokit.issues.get.mockResolvedValue(mockIssueResponse);

        const result = await service.getIssue('owner/repo', 1);

        expect(result).not.toBeNull();
        expect(result!.number).toBe(1);
      });

      it('should return null for 404', async () => {
        mockOctokit.issues.get.mockRejectedValue({ status: 404 });

        const result = await service.getIssue('owner/repo', 999);

        expect(result).toBeNull();
      });
    });

    describe('searchIssues', () => {
      it('should search issues and exclude PRs', async () => {
        mockOctokit.search.issuesAndPullRequests.mockResolvedValue({
          data: {
            items: [
              {
                number: 1,
                title: 'Issue',
                body: 'body',
                state: 'open',
                html_url: 'url',
                labels: [],
                assignees: [],
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
              },
              {
                number: 2,
                title: 'PR',
                body: 'body',
                state: 'open',
                html_url: 'url',
                labels: [],
                assignees: [],
                created_at: '2024-01-01T00:00:00Z',
                updated_at: '2024-01-01T00:00:00Z',
                pull_request: {}, // This is a PR
              },
            ],
          },
        });

        const results = await service.searchIssues('owner/repo', 'is:open');

        expect(results).toHaveLength(1);
        expect(results[0].number).toBe(1);
      });

      describe('sanitizeSearchQuery (via searchIssues)', () => {
        const emptySearchResult = { data: { items: [] } };

        it('should preserve is:, label:, and closed: qualifiers', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'is:issue is:open label:liveops');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo is:issue is:open label:liveops',
            })
          );
        });

        it('should preserve closed: qualifier with date range', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'is:issue is:closed label:liveops closed:>2026-01-01');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo is:issue is:closed label:liveops closed:>2026-01-01',
            })
          );
        });

        it('should strip repo: qualifier but preserve other qualifiers', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'repo:evil/hack is:open');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo is:open',
            })
          );
        });

        it('should strip org: qualifier but preserve label:', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'org:competitor label:bug');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo label:bug',
            })
          );
        });

        it('should strip user: qualifier', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'user:attacker is:issue');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo is:issue',
            })
          );
        });

        it('should strip quoted repo: values', async () => {
          mockOctokit.search.issuesAndPullRequests.mockResolvedValue(emptySearchResult);

          await service.searchIssues('owner/repo', 'repo:"evil/hack" is:open');

          expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
            expect.objectContaining({
              q: 'repo:owner/repo is:open',
            })
          );
        });
      });
    });

    describe('updateIssue', () => {
      it('should update an issue successfully', async () => {
        const mockIssueResponse = {
          data: {
            number: 1,
            title: 'Updated Title',
            body: 'Updated body',
            state: 'open',
            html_url: 'https://github.com/owner/repo/issues/1',
            labels: [{ name: 'bug', color: 'ff0000' }],
            assignees: [{ login: 'user1' }],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        };
        mockOctokit.issues.update.mockResolvedValue(mockIssueResponse);

        const result = await service.updateIssue('owner/repo', 1, {
          title: 'Updated Title',
          body: 'Updated body',
        });

        expect(result).not.toBeNull();
        expect(result!.title).toBe('Updated Title');
        expect(mockOctokit.issues.update).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          issue_number: 1,
          title: 'Updated Title',
          body: 'Updated body',
          state: undefined,
          labels: undefined,
          assignees: undefined,
        });
      });

      it('should return null for repo not in allowlist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['allowed/repo'],
        });
        service = (await GitHubService.forOrganization('org-123', logger))!;

        const result = await service.updateIssue('other/repo', 1, { title: 'Test' });

        expect(result).toBeNull();
        expect(mockOctokit.issues.update).not.toHaveBeenCalled();
      });
    });

    describe('addIssueComment', () => {
      it('should add a comment successfully', async () => {
        const mockCommentResponse = {
          data: {
            id: 123,
            body: 'Test comment',
            html_url: 'https://github.com/owner/repo/issues/1#issuecomment-123',
            user: { login: 'testuser' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        };
        mockOctokit.issues.createComment.mockResolvedValue(mockCommentResponse);

        const result = await service.addIssueComment('owner/repo', 1, 'Test comment');

        expect(result).not.toBeNull();
        expect(result!.body).toBe('Test comment');
        expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          issue_number: 1,
          body: 'Test comment',
        });
      });

      it('should return null for repo not in allowlist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['allowed/repo'],
        });
        service = (await GitHubService.forOrganization('org-123', logger))!;

        const result = await service.addIssueComment('other/repo', 1, 'Test comment');

        expect(result).toBeNull();
        expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
      });
    });

    describe('closeIssue', () => {
      it('should close an issue by updating state', async () => {
        const mockIssueResponse = {
          data: {
            number: 1,
            title: 'Test Issue',
            body: 'Test body',
            state: 'closed',
            html_url: 'https://github.com/owner/repo/issues/1',
            labels: [],
            assignees: [],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        };
        mockOctokit.issues.update.mockResolvedValue(mockIssueResponse);

        const result = await service.closeIssue('owner/repo', 1);

        expect(result).not.toBeNull();
        expect(result!.state).toBe('closed');
        expect(mockOctokit.issues.update).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: 'owner',
            repo: 'repo',
            issue_number: 1,
            state: 'closed',
          })
        );
      });
    });

    describe('reopenIssue', () => {
      it('reopens an issue by updating its state to open', async () => {
        mockOctokit.issues.update.mockResolvedValue({
          data: {
            number: 7,
            title: 'Test Issue',
            body: 'Test body',
            state: 'open',
            state_reason: 'reopened',
            html_url: 'https://github.com/owner/repo/issues/7',
            labels: [],
            assignees: [],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        });

        const result = await service.reopenIssue('owner/repo', 7);

        expect(result).toMatchObject({ number: 7, state: 'open', state_reason: 'reopened' });
        expect(mockOctokit.issues.update).toHaveBeenCalledWith(
          expect.objectContaining({ owner: 'owner', repo: 'repo', issue_number: 7, state: 'open' })
        );
      });
    });

    describe('listIssues', () => {
      it('maps the state reason of closed issues and leaves pull requests out', async () => {
        const issue = (number: number, extra: Record<string, unknown>) => ({
          number,
          title: `Issue ${number}`,
          body: null,
          html_url: `https://github.com/owner/repo/issues/${number}`,
          labels: [],
          assignees: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          ...extra,
        });
        mockOctokit.issues.listForRepo.mockResolvedValue({
          data: [
            issue(1, { state: 'closed', state_reason: 'not_planned', closed_at: '2024-01-03T00:00:00Z' }),
            issue(2, { state: 'open' }),
            issue(3, { state: 'open', pull_request: {} }),
          ],
        });

        const result = await service.listIssues('owner/repo', { state: 'all', labels: 'a,b', page: 2 });

        expect(result.map(i => [i.number, i.state, i.state_reason])).toEqual([
          [1, 'closed', 'not_planned'],
          [2, 'open', null],
        ]);
        expect(mockOctokit.issues.listForRepo).toHaveBeenCalledWith(
          expect.objectContaining({ owner: 'owner', repo: 'repo', state: 'all', labels: 'a,b', page: 2 })
        );
      });
    });

    describe('listAllIssues', () => {
      const raw = (number: number, pr = false) => ({
        number,
        title: `Issue ${number}`,
        body: null,
        state: 'open',
        html_url: `https://github.com/owner/repo/issues/${number}`,
        labels: [],
        assignees: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        ...(pr ? { pull_request: {} } : {}),
      });

      const feedPages = (pages: unknown[][], lastHasNext = false) =>
        mockOctokit.paginate.mockImplementation(
          async (
            _method: unknown,
            _params: unknown,
            mapFn: (response: { data: unknown[] }, done: () => void) => unknown[]
          ) => {
            const out: unknown[] = [];
            let stopped = false;
            for (const [i, data] of pages.entries()) {
              if (stopped) break;
              const hasNext = i < pages.length - 1 || lastHasNext;
              const headers = hasNext ? { link: '<https://api.github.com/next>; rel="next"' } : {};
              out.push(...mapFn({ data, headers } as never, () => (stopped = true)));
            }
            return out;
          }
        );

      it('keeps paging past a page that is all pull requests and reports no truncation', async () => {
        const prPage = Array.from({ length: 100 }, (_, i) => raw(i + 1, true));
        feedPages([prPage, [raw(500), raw(501)]]);

        const result = await service.listAllIssues('owner/repo', { state: 'all', since: '2024-01-01T00:00:00Z' });

        expect(result.issues.map(i => i.number)).toEqual([500, 501]);
        expect(result.truncated).toBe(false);
        expect(mockOctokit.paginate).toHaveBeenCalledWith(
          mockOctokit.issues.listForRepo,
          expect.objectContaining({ state: 'all', since: '2024-01-01T00:00:00Z', per_page: 100 }),
          expect.any(Function)
        );
      });

      it('reports truncated when maxPages is reached on a full page', async () => {
        const full = (start: number) => Array.from({ length: 100 }, (_, i) => raw(start + i));
        feedPages([full(1), full(101), full(201)]);

        const result = await service.listAllIssues('owner/repo', { state: 'open', maxPages: 2 });

        expect(result.issues).toHaveLength(200);
        expect(result.truncated).toBe(true);
      });

      it('reports no truncation when the last page is exactly full', async () => {
        const full = (start: number) => Array.from({ length: 100 }, (_, i) => raw(start + i));
        feedPages([full(1), full(101)]);

        const result = await service.listAllIssues('owner/repo', { state: 'open', maxPages: 2 });

        expect(result.issues).toHaveLength(200);
        expect(result.truncated).toBe(false);
      });

      it.each([0, -3, Number.NaN, undefined])('clamps maxPages %s so at least one page is read', async maxPages => {
        const full = Array.from({ length: 100 }, (_, i) => raw(i + 1));
        feedPages([full, full], true);

        const result = await service.listAllIssues('owner/repo', { state: 'open', maxPages });

        expect(result.issues).toHaveLength(maxPages === undefined || Number.isNaN(maxPages) ? 200 : 100);
      });

      it('throws for a repo outside the whitelist without calling GitHub', async () => {
        await expect(service.listAllIssues('other/repo', { state: 'open' })).rejects.toBeInstanceOf(
          GitHubRepoNotAllowedError
        );
        expect(mockOctokit.paginate).not.toHaveBeenCalled();
      });
    });

    describe('listCommits', () => {
      it('omits sha from the request when none is given', async () => {
        mockOctokit.repos.listCommits.mockResolvedValue({ data: [] });

        await service.listCommits('owner/repo', { since: new Date('2024-01-01T00:00:00Z') });

        const params = mockOctokit.repos.listCommits.mock.calls[0][0] as Record<string, unknown>;
        expect('sha' in params).toBe(false);
      });
    });

    describe('listIssues author', () => {
      it('maps the issue author, or null when absent', async () => {
        const issue = (number: number, user: unknown) => ({
          number,
          title: `Issue ${number}`,
          body: null,
          state: 'open',
          html_url: `https://github.com/owner/repo/issues/${number}`,
          labels: [],
          assignees: [],
          user,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        });
        mockOctokit.issues.listForRepo.mockResolvedValue({
          data: [issue(1, { login: 'author', id: 5 }), issue(2, null)],
        });

        const result = await service.listIssues('owner/repo');

        expect(result.map(i => i.user)).toEqual([{ login: 'author' }, null]);
      });
    });

    describe('Error Handling', () => {
      it('updateIssue should propagate non-404 errors', async () => {
        mockOctokit.issues.update.mockRejectedValue({ status: 403, message: 'Forbidden' });

        await expect(service.updateIssue('owner/repo', 1, { title: 'Test' })).rejects.toMatchObject({
          status: 403,
        });
      });

      it('addIssueComment should propagate API errors', async () => {
        mockOctokit.issues.createComment.mockRejectedValue({ status: 500, message: 'Server Error' });

        await expect(service.addIssueComment('owner/repo', 1, 'Test')).rejects.toMatchObject({
          status: 500,
        });
      });

      it('closeIssue should propagate errors from updateIssue', async () => {
        mockOctokit.issues.update.mockRejectedValue({ status: 401, message: 'Unauthorized' });

        await expect(service.closeIssue('owner/repo', 1)).rejects.toMatchObject({
          status: 401,
        });
      });
    });
  });

  describe('Label Operations', () => {
    let service: GitHubService;

    beforeEach(async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      service = (await GitHubService.forOrganization('org-123', logger))!;
    });

    describe('listLabels', () => {
      it('should list labels', async () => {
        mockOctokit.issues.listLabelsForRepo.mockResolvedValue({
          data: [
            { id: 1, name: 'bug', color: 'ff0000', description: 'Bug label' },
            { id: 2, name: 'feature', color: '00ff00', description: null },
          ],
        });

        const labels = await service.listLabels('owner/repo');

        expect(labels).toHaveLength(2);
        expect(labels[0].name).toBe('bug');
      });

      it('should return empty array for repo not in allowlist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['allowed/repo'],
        });
        service = (await GitHubService.forOrganization('org-123', logger))!;

        const labels = await service.listLabels('other/repo');

        expect(labels).toEqual([]);
        expect(mockOctokit.issues.listLabelsForRepo).not.toHaveBeenCalled();
      });
    });

    describe('createLabel', () => {
      it('should create a label successfully', async () => {
        mockOctokit.issues.createLabel.mockResolvedValue({
          data: { id: 1, name: 'new-label', color: '0000ff', description: 'New label' },
        });

        const label = await service.createLabel('owner/repo', {
          name: 'new-label',
          color: '#0000ff',
          description: 'New label',
        });

        expect(label).not.toBeNull();
        expect(label!.name).toBe('new-label');
        expect(mockOctokit.issues.createLabel).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          name: 'new-label',
          color: '0000ff', // # stripped
          description: 'New label',
        });
      });

      it('should return null for repo not in allowlist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['allowed/repo'],
        });
        service = (await GitHubService.forOrganization('org-123', logger))!;

        const label = await service.createLabel('other/repo', { name: 'test', color: 'ff0000' });

        expect(label).toBeNull();
        expect(mockOctokit.issues.createLabel).not.toHaveBeenCalled();
      });
    });

    describe('ensureLabelExists', () => {
      it('should return existing label', async () => {
        mockOctokit.issues.listLabelsForRepo.mockResolvedValue({
          data: [{ id: 1, name: 'bug', color: 'ff0000', description: 'Bug label' }],
        });

        const label = await service.ensureLabelExists('owner/repo', {
          name: 'bug',
          color: 'ff0000',
        });

        expect(label).not.toBeNull();
        expect(label!.name).toBe('bug');
        expect(mockOctokit.issues.createLabel).not.toHaveBeenCalled();
      });

      it('should create label if not exists', async () => {
        mockOctokit.issues.listLabelsForRepo.mockResolvedValue({ data: [] });
        mockOctokit.issues.createLabel.mockResolvedValue({
          data: { id: 1, name: 'new-label', color: '0000ff', description: null },
        });

        const label = await service.ensureLabelExists('owner/repo', {
          name: 'new-label',
          color: '#0000ff',
        });

        expect(label).not.toBeNull();
        expect(mockOctokit.issues.createLabel).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          name: 'new-label',
          color: '0000ff', // # should be stripped
          description: undefined,
        });
      });
    });

    describe('Error Handling', () => {
      it('listLabels should propagate API errors', async () => {
        mockOctokit.issues.listLabelsForRepo.mockRejectedValue({ status: 500, message: 'Server Error' });

        await expect(service.listLabels('owner/repo')).rejects.toMatchObject({
          status: 500,
        });
      });

      it('createLabel should return null on API errors', async () => {
        // Use a non-422 error since 422 with "already_exists" has special handling
        mockOctokit.issues.createLabel.mockRejectedValue({ status: 500, message: 'Server Error' });

        const result = await service.createLabel('owner/repo', { name: 'test', color: 'ff0000' });
        expect(result).toBeNull();
      });
    });
  });

  describe('Test Connection', () => {
    describe('PAT connection', () => {
      it('should return user info for PAT', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
        mockOctokit.users.getAuthenticated.mockResolvedValue({
          data: { login: 'testuser', id: 123 },
        });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        const result = (await service.testConnection()) as ITestConnectionSuccess;

        expect(result.success).toBe(true);
        expect(result.type).toBe('user');
        expect(result.login).toBe('testuser');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('GitHub App connection', () => {
      it('should return app info for GitHub App', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockAppConnection);
        mockOctokit.apps.getAuthenticated.mockResolvedValue({
          data: { name: 'Test App', slug: 'test-app', id: 456 },
        });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        const result = (await service.testConnection()) as ITestConnectionSuccess;

        expect(result.success).toBe(true);
        expect(result.type).toBe('app');
        expect(result.appName).toBe('Test App');
        expect(result.login).toBe('test-app');
      });
    });

    it('should return error on failure', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.users.getAuthenticated.mockRejectedValue(new Error('Auth failed'));

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const result = (await service.testConnection()) as ITestConnectionFailure;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Auth failed');
    });
  });

  describe('Rate Limit', () => {
    it('should check rate limit', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.rateLimit.get.mockResolvedValue({
        data: {
          resources: {
            core: {
              limit: 5000,
              remaining: 4500,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const rateLimit = await service.checkRateLimit();

      expect(rateLimit.limit).toBe(5000);
      expect(rateLimit.remaining).toBe(4500);
      expect(rateLimit.usagePercent).toBe(10);
    });
  });

  describe('Repository Operations', () => {
    describe('listRepositories', () => {
      it('should list repositories for PAT and filter by whitelist', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: ['owner/repo1', 'owner/repo2'],
        });
        mockOctokit.repos.listForAuthenticatedUser.mockResolvedValue({
          data: [
            { id: 1, name: 'repo1', full_name: 'owner/repo1', private: false, html_url: 'url1', description: null },
            { id: 2, name: 'repo2', full_name: 'owner/repo2', private: true, html_url: 'url2', description: 'desc' },
            { id: 3, name: 'repo3', full_name: 'owner/repo3', private: false, html_url: 'url3', description: null },
          ],
        });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        const repos = await service.listRepositories();

        // repo3 should be filtered out (not in whitelist)
        expect(repos).toHaveLength(2);
        expect(repos.map(r => r.full_name)).toEqual(['owner/repo1', 'owner/repo2']);
      });

      it('should list repositories for GitHub App', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockAppConnection,
          allowedRepositories: ['owner/repo1'],
        });
        mockOctokit.apps.listReposAccessibleToInstallation.mockResolvedValue({
          data: {
            repositories: [
              { id: 1, name: 'repo1', full_name: 'owner/repo1', private: false, html_url: 'url1', description: null },
            ],
          },
        });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        const repos = await service.listRepositories();

        expect(repos).toHaveLength(1);
        expect(mockOctokit.apps.listReposAccessibleToInstallation).toHaveBeenCalled();
      });

      it('should return empty array when whitelist is empty (fail-closed)', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
          ...mockConnection,
          allowedRepositories: [],
        });
        mockOctokit.repos.listForAuthenticatedUser.mockResolvedValue({
          data: [
            { id: 1, name: 'repo1', full_name: 'owner/repo1', private: false, html_url: 'url1', description: null },
          ],
        });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        const repos = await service.listRepositories();

        // Empty whitelist = fail-closed, so all repos filtered
        expect(repos).toHaveLength(0);
      });

      it('should propagate API errors', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
        mockOctokit.repos.listForAuthenticatedUser.mockRejectedValue({ status: 403, message: 'Forbidden' });

        const service = (await GitHubService.forOrganization('org-123', logger))!;
        await expect(service.listRepositories()).rejects.toMatchObject({
          status: 403,
        });
      });
    });
  });

  describe('getAuthenticatedEntity', () => {
    it('should return user info for PAT connection', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.users.getAuthenticated.mockResolvedValue({
        data: { login: 'testuser', id: 123 },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const entity = await service.getAuthenticatedEntity();

      expect(entity).not.toBeNull();
      expect(entity!.type).toBe('user');
      expect(entity!.login).toBe('testuser');
      expect(entity!.id).toBe(123);
    });

    it('should return app info for GitHub App connection', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockAppConnection);
      mockOctokit.apps.getAuthenticated.mockResolvedValue({
        data: { name: 'Test App', slug: 'test-app', id: 456 },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const entity = await service.getAuthenticatedEntity();

      expect(entity).not.toBeNull();
      expect(entity!.type).toBe('app');
      expect(entity!.login).toBe('test-app');
      expect(entity!.id).toBe(456);
    });

    it('should return null on error', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.users.getAuthenticated.mockRejectedValue(new Error('Auth failed'));

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const entity = await service.getAuthenticatedEntity();

      expect(entity).toBeNull();
    });
  });

  describe('Repository Allowlist', () => {
    // Fail-closed: empty allowlist blocks all access
    it('should block all repos when allowlist is empty (fail-closed)', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: [],
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const repo = await service.getRepository('owner/any-repo');

      expect(repo).toBeNull();
      expect(mockOctokit.repos.get).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SECURITY: Repository access denied'),
        expect.objectContaining({ reason: 'empty_whitelist' })
      );
    });

    it('should block repos not in allowlist', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['allowed/repo'],
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const repo = await service.getRepository('blocked/repo');

      expect(repo).toBeNull();
      expect(mockOctokit.repos.get).not.toHaveBeenCalled();
    });

    it('maps whether the repository is archived and has issues enabled', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['owner/repo'],
      });
      mockOctokit.repos.get.mockResolvedValue({
        data: {
          id: 1,
          name: 'repo',
          full_name: 'owner/repo',
          private: true,
          html_url: 'url',
          description: null,
          archived: true,
          has_issues: false,
        },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;

      expect(await service.getRepository('owner/repo')).toMatchObject({ archived: true, has_issues: false });
    });

    // Guards against allowlist bypass via case or whitespace tricks
    it('should handle case-insensitive matching', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['Owner/Repo'],
      });
      mockOctokit.repos.get.mockResolvedValue({
        data: {
          id: 1,
          name: 'repo',
          full_name: 'owner/repo',
          private: false,
          html_url: 'url',
          description: null,
        },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const repo = await service.getRepository('owner/repo');

      expect(repo).not.toBeNull();
      expect(mockOctokit.repos.get).toHaveBeenCalled();
    });

    it('should handle whitespace in repo names', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['owner/repo'],
      });
      mockOctokit.repos.get.mockResolvedValue({
        data: {
          id: 1,
          name: 'repo',
          full_name: 'owner/repo',
          private: false,
          html_url: 'url',
          description: null,
        },
      });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      // Trailing space should be trimmed and still match
      const repo = await service.getRepository('  owner/repo  ');

      expect(repo).not.toBeNull();
      expect(mockOctokit.repos.get).toHaveBeenCalled();
    });
  });

  describe('listDirectoryContents', () => {
    let service: GitHubService;

    beforeEach(async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      service = (await GitHubService.forOrganization('org-123', logger))!;
    });

    it('should list directory entries', async () => {
      mockOctokit.repos.getContent.mockResolvedValue({
        data: [
          { name: 'file1.ts', path: 'src/file1.ts', type: 'file', size: 1234 },
          { name: 'utils', path: 'src/utils', type: 'dir', size: 0 },
        ],
      });

      const entries = await service.listDirectoryContents('owner/repo', 'src');

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ name: 'file1.ts', path: 'src/file1.ts', type: 'file', size: 1234 });
      expect(entries[1]).toEqual({ name: 'utils', path: 'src/utils', type: 'dir', size: 0 });
    });

    it('should return [] for 404', async () => {
      mockOctokit.repos.getContent.mockRejectedValue({ status: 404 });

      const entries = await service.listDirectoryContents('owner/repo', 'nonexistent');

      expect(entries).toEqual([]);
    });

    it('should return [] when path is a file (non-array response)', async () => {
      mockOctokit.repos.getContent.mockResolvedValue({
        data: { name: 'file.ts', path: 'src/file.ts', type: 'file', content: 'abc', encoding: 'base64' },
      });

      const entries = await service.listDirectoryContents('owner/repo', 'src/file.ts');

      expect(entries).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('listDirectoryContents called with a file path'),
        expect.any(Object)
      );
    });

    it('should return [] for repo not in allowlist', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['allowed/repo'],
      });
      service = (await GitHubService.forOrganization('org-123', logger))!;

      const entries = await service.listDirectoryContents('other/repo', 'src');

      expect(entries).toEqual([]);
      expect(mockOctokit.repos.getContent).not.toHaveBeenCalled();
    });

    it('should propagate non-404 errors', async () => {
      mockOctokit.repos.getContent.mockRejectedValue({ status: 500, message: 'Server Error' });

      await expect(service.listDirectoryContents('owner/repo', 'src')).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe('searchCode', () => {
    let service: GitHubService;

    beforeEach(async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      service = (await GitHubService.forOrganization('org-123', logger))!;
    });

    it('should return [] for empty search results', async () => {
      mockOctokit.search.code.mockResolvedValue({ data: { items: [] } });

      const results = await service.searchCode('owner/repo', 'nonexistent');

      expect(results).toEqual([]);
    });

    it('should handle missing text_matches gracefully', async () => {
      mockOctokit.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: 'src/file.ts',
              repository: { full_name: 'owner/repo' },
              // no text_matches field - happens if Accept header not forwarded
            },
          ],
        },
      });

      const results = await service.searchCode('owner/repo', 'query');

      expect(results).toHaveLength(1);
      expect(results[0].textMatches).toEqual([]);
    });

    it('should return results with text matches', async () => {
      mockOctokit.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: 'src/utils.ts',
              repository: { full_name: 'owner/repo' },
              text_matches: [{ fragment: 'function sendToQueue' }],
            },
          ],
        },
      });

      const results = await service.searchCode('owner/repo', 'sendToQueue');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        path: 'src/utils.ts',
        repository: 'owner/repo',
        textMatches: ['function sendToQueue'],
      });
    });

    it('should throw GitHubRateLimitError on 403 rate limit', async () => {
      mockOctokit.search.code.mockRejectedValue({ status: 403 });

      await expect(service.searchCode('owner/repo', 'test')).rejects.toThrow(GitHubRateLimitError);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Code search rate limit'),
        expect.any(Object)
      );
    });

    it('should throw GitHubRateLimitError on 429 rate limit', async () => {
      mockOctokit.search.code.mockRejectedValue({ status: 429 });

      await expect(service.searchCode('owner/repo', 'test')).rejects.toThrow(GitHubRateLimitError);
    });

    it('should return [] on 422 validation error', async () => {
      mockOctokit.search.code.mockRejectedValue({ status: 422 });

      const results = await service.searchCode('owner/repo', 'test');

      expect(results).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Code search validation error'),
        expect.any(Object)
      );
    });

    it('should return [] for repo not in allowlist', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue({
        ...mockConnection,
        allowedRepositories: ['allowed/repo'],
      });
      service = (await GitHubService.forOrganization('org-123', logger))!;

      const results = await service.searchCode('other/repo', 'test');

      expect(results).toEqual([]);
      expect(mockOctokit.search.code).not.toHaveBeenCalled();
    });

    it('should strip repo: qualifier from query (sanitizeSearchQuery)', async () => {
      mockOctokit.search.code.mockResolvedValue({ data: { items: [] } });

      await service.searchCode('owner/repo', 'repo:evil/hack sendToQueue');

      expect(mockOctokit.search.code).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'repo:owner/repo sendToQueue',
        })
      );
    });

    it('should propagate non-rate-limit errors', async () => {
      mockOctokit.search.code.mockRejectedValue({ status: 500, message: 'Server Error' });

      await expect(service.searchCode('owner/repo', 'test')).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should handle 404 errors by returning null', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.issues.get.mockRejectedValue({ status: 404, message: 'Not Found' });

      const service = (await GitHubService.forOrganization('org-123', logger))!;
      const issue = await service.getIssue('owner/repo', 999);

      // 404 errors should return null (issue doesn't exist)
      expect(issue).toBeNull();
    });

    it('should propagate non-404 errors for proper error handling', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.issues.get.mockRejectedValue({ status: 401, message: 'Bad credentials' });

      const service = (await GitHubService.forOrganization('org-123', logger))!;

      // Non-404 errors should propagate for proper handling at call site
      await expect(service.getIssue('owner/repo', 1)).rejects.toMatchObject({ status: 401 });
    });

    it('should track health metrics on API errors', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      mockOctokit.repos.get.mockRejectedValue({ status: 500, message: 'Internal Server Error' });

      const service = (await GitHubService.forOrganization('org-123', logger))!;

      // Error should propagate, but health metrics should be updated
      await expect(service.getRepository('owner/repo')).rejects.toMatchObject({ status: 500 });
      expect(mockRepository.updateHealthInfo).toHaveBeenCalled();
    });
  });
  describe('forOrganizationResult', () => {
    it('reports missing, disabled and suspended connections', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce(null);
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({ ok: false, reason: 'missing' });

      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce({ ...mockConnection, enabled: false });
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({ ok: false, reason: 'disabled' });

      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce({
        ...mockConnection,
        suspendedAt: new Date(),
      });
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({ ok: false, reason: 'suspended' });
    });

    it('reports error when the lookup throws, while forOrganization still returns null', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockRejectedValue(new Error('db down'));

      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({ ok: false, reason: 'error' });
      expect(await GitHubService.forOrganization('org-1', logger)).toBeNull();
    });

    it('reports misconfigured for a missing key and error for a DB throw', async () => {
      mockConfig.SECRET_ENCRYPTION_KEY = '';
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce(mockConnection);
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({
        ok: false,
        reason: 'misconfigured',
      });

      mockConfig.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce({
        ...mockAppConnection,
        privateKey: undefined,
      });
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({
        ok: false,
        reason: 'misconfigured',
      });

      mockRepository.findByOrganizationIdWithCredentials.mockRejectedValueOnce(new Error('db down'));
      expect(await GitHubService.forOrganizationResult('org-1', logger)).toEqual({ ok: false, reason: 'error' });
    });

    it('returns the service and connection type for service account and app connections', async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce(mockConnection);
      const pat = await GitHubService.forOrganizationResult('org-1', logger);
      expect(pat).toMatchObject({ ok: true, connectionType: 'service_account' });
      expect(pat.ok && pat.service).toBeInstanceOf(GitHubService);

      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValueOnce(mockAppConnection);
      const app = await GitHubService.forOrganizationResult('org-1', logger);
      expect(app).toMatchObject({ ok: true, connectionType: 'github_app' });
    });
  });

  describe('Read methods', () => {
    let service: GitHubService;

    beforeEach(async () => {
      mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockConnection);
      service = (await GitHubService.forOrganization('org-1', logger)) as GitHubService;
    });

    describe('listContributors', () => {
      const contributor = (login: string | null) => ({
        login,
        contributions: 3,
        avatar_url: `https://a/${login}`,
        html_url: `https://h/${login}`,
      });

      it('walks every page and skips entries without a login', async () => {
        const page1 = Array.from({ length: 100 }, (_, i) => contributor(`user${i}`));
        mockOctokit.request
          .mockResolvedValueOnce({ status: 200, data: page1 })
          .mockResolvedValueOnce({ status: 200, data: [contributor(null), contributor('last')] });

        const result = await service.listContributors('owner/repo');

        expect(result).toHaveLength(101);
        expect(result[100]).toEqual({
          login: 'last',
          contributions: 3,
          avatarUrl: 'https://a/last',
          htmlUrl: 'https://h/last',
        });
        expect(mockOctokit.request).toHaveBeenCalledTimes(2);
      });

      it('returns [] for a 204 empty repository', async () => {
        mockOctokit.request.mockResolvedValue({ status: 204, data: undefined });

        expect(await service.listContributors('owner/repo')).toEqual([]);
      });
    });

    describe('getCommitActivity', () => {
      it('returns pending on 202', async () => {
        mockOctokit.request.mockResolvedValue({ status: 202, data: {} });

        expect(await service.getCommitActivity('owner/repo')).toEqual({ status: 'pending' });
      });

      it('returns weeks on 200 and an empty list on 204', async () => {
        mockOctokit.request.mockResolvedValueOnce({
          status: 200,
          data: [{ total: 4, week: 1700000000, days: [0, 1, 2, 1, 0, 0, 0] }],
        });
        expect(await service.getCommitActivity('owner/repo')).toEqual({
          status: 'ok',
          weeks: [{ total: 4, week: 1700000000, days: [0, 1, 2, 1, 0, 0, 0] }],
        });

        mockOctokit.request.mockResolvedValueOnce({ status: 204, data: undefined });
        expect(await service.getCommitActivity('owner/repo')).toEqual({ status: 'ok', weeks: [] });
      });
    });

    describe('getPullRequest', () => {
      it('maps a pull request', async () => {
        mockOctokit.pulls.get.mockResolvedValue({
          data: {
            number: 7,
            title: 'T',
            body: null,
            state: 'closed',
            html_url: 'https://h/7',
            merged_at: '2024-01-02T00:00:00Z',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
            closed_at: '2024-01-02T00:00:00Z',
            user: { login: 'dev' },
            labels: [{ name: 'bug' }],
            draft: false,
            merged: true,
            additions: 10,
            deletions: 2,
            changed_files: 3,
            commits: 1,
            base: { ref: 'main' },
            head: { ref: 'feat/x' },
            requested_reviewers: [{ login: 'rev', avatar_url: 'https://a/rev' }],
          },
        });

        const pr = await service.getPullRequest('owner/repo', 7);

        expect(mockOctokit.pulls.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 7 });
        expect(pr).toMatchObject({
          number: 7,
          user: { login: 'dev' },
          labels: [{ name: 'bug' }],
          merged: true,
          base_ref: 'main',
          head_ref: 'feat/x',
          additions: 10,
          requestedReviewers: [{ login: 'rev', avatarUrl: 'https://a/rev' }],
        });
      });
    });

    describe('getUser', () => {
      it('maps a user', async () => {
        mockOctokit.users.getByUsername.mockResolvedValue({
          data: { login: 'dev', name: null, avatar_url: 'https://a', html_url: 'https://h' },
        });

        expect(await service.getUser('dev')).toEqual({
          login: 'dev',
          name: null,
          avatarUrl: 'https://a',
          htmlUrl: 'https://h',
        });
      });
    });

    describe('listCommitsByAuthor', () => {
      it('keeps the GitHub login and passes the filters', async () => {
        mockOctokit.repos.listCommits.mockResolvedValue({
          data: [
            {
              sha: 'abc1234567',
              commit: { message: 'm1', author: { name: 'Dev', date: 'd1' } },
              author: { login: 'dev' },
            },
            { sha: 'def7654321', commit: { message: 'm2', author: { name: 'Dev', date: 'd2' } }, author: null },
          ],
        });
        const since = new Date('2024-01-01T00:00:00Z');
        const until = new Date('2024-02-01T00:00:00Z');

        const result = await service.listCommitsByAuthor('owner/repo', { author: 'dev', since, until });

        expect(mockOctokit.repos.listCommits).toHaveBeenCalledWith(
          expect.objectContaining({
            author: 'dev',
            since: since.toISOString(),
            until: until.toISOString(),
            per_page: 100,
          })
        );
        expect(result).toEqual([
          { sha: 'abc1234567', message: 'm1', authorName: 'Dev', authorLogin: 'dev', date: 'd1' },
          { sha: 'def7654321', message: 'm2', authorName: 'Dev', authorLogin: null, date: 'd2' },
        ]);
      });
    });

    it('returns [] from listCommitsByAuthor for an empty repository (409)', async () => {
      mockOctokit.repos.listCommits.mockRejectedValue(
        Object.assign(new Error('Git Repository is empty.'), { status: 409 })
      );

      await expect(service.listCommitsByAuthor('owner/repo', { author: 'dev' })).resolves.toEqual([]);
    });

    describe('searchIssuesAndPulls', () => {
      const item = (number: number, pr: boolean) => ({
        number,
        title: `t${number}`,
        body: null,
        state: 'open',
        html_url: `https://h/${number}`,
        repository_url: 'https://api.github.com/repos/owner/repo',
        user: { login: 'dev' },
        labels: [{ name: 'bug' }, 'plain'],
        created_at: 'c',
        updated_at: 'u',
        closed_at: null,
        ...(pr ? { pull_request: {} } : {}),
      });

      it('returns both kinds with totalCount and one query over all repos', async () => {
        mockOctokit.search.issuesAndPullRequests.mockResolvedValue({
          data: { total_count: 42, items: [item(1, false), item(2, true)] },
        });

        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockAppConnection);
        const appService = (await GitHubService.forOrganization('org-1', logger)) as GitHubService;

        const result = await appService.searchIssuesAndPulls(['owner/repo', 'owner/repo1'], 'is:open');

        expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
        expect(mockOctokit.search.issuesAndPullRequests.mock.calls[0][0].q).toBe(
          'repo:owner/repo repo:owner/repo1 is:open'
        );
        expect(result.totalCount).toBe(42);
        expect(result.items.map(i => [i.number, i.isPullRequest])).toEqual([
          [1, false],
          [2, true],
        ]);
        expect(result.items[0]).toMatchObject({ repo: 'owner/repo', labels: ['bug', 'plain'], user: 'dev' });
      });

      it('maps mergedAt and draft, null and false for plain issues', async () => {
        mockOctokit.search.issuesAndPullRequests.mockResolvedValue({
          data: {
            total_count: 3,
            items: [
              item(1, false),
              { ...item(2, true), pull_request: { merged_at: '2024-02-01T00:00:00Z' } },
              { ...item(3, true), draft: true },
            ],
          },
        });

        const result = await service.searchIssuesAndPulls(['owner/repo'], 'x');

        expect(result.items.map(i => [i.mergedAt, i.draft])).toEqual([
          [null, false],
          ['2024-02-01T00:00:00Z', false],
          [null, true],
        ]);
      });

      it('drops items from non-whitelisted or unrequested repos and keeps mixed-case matches', async () => {
        const inRepo = (n: number, url: string) => ({ ...item(n, false), repository_url: url });
        mockOctokit.search.issuesAndPullRequests.mockResolvedValue({
          data: {
            total_count: 99,
            items: [
              inRepo(1, 'https://api.github.com/repos/other/secret'),
              inRepo(2, 'https://api.github.com/repos/owner/repo1'),
              inRepo(3, 'https://api.github.com/repos/Owner/Repo'),
            ],
          },
        });
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockAppConnection);
        const appService = (await GitHubService.forOrganization('org-1', logger)) as GitHubService;

        const result = await appService.searchIssuesAndPulls(['owner/repo'], 'x');

        expect(result.items.map(i => i.number)).toEqual([3]);
        expect(result.totalCount).toBe(99);
      });

      it('rejects a repo outside the whitelist without searching', async () => {
        await expect(service.searchIssuesAndPulls(['owner/repo', 'other/repo'], 'x')).rejects.toBeInstanceOf(
          GitHubRepoNotAllowedError
        );
        expect(mockOctokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
      });

      it('strips repo-escaping qualifiers from the user query', async () => {
        mockOctokit.search.issuesAndPullRequests.mockResolvedValue({ data: { total_count: 0, items: [] } });

        await service.searchIssuesAndPulls(['owner/repo'], 'bug org:evil repo:evil/x user:evil is:open');

        expect(mockOctokit.search.issuesAndPullRequests.mock.calls[0][0].q).toBe('repo:owner/repo bug    is:open');
      });
    });

    describe('listMergedPullRequests', () => {
      const pr = (number: number, merged_at: string | null) => ({
        number,
        title: `PR ${number}`,
        body: null,
        state: 'closed',
        html_url: `https://h/${number}`,
        merged_at,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        user: { login: 'author' },
        labels: [],
      });

      it('omits base when none is given and still filters by since', async () => {
        mockOctokit.paginate.mockResolvedValue([
          pr(1, '2024-02-01T00:00:00Z'),
          pr(2, '2023-12-01T00:00:00Z'),
          pr(3, null),
        ]);

        const result = await service.listMergedPullRequests('owner/repo', { since: new Date('2024-01-15T00:00:00Z') });

        expect(result.map(p => p.number)).toEqual([1]);
        const params = mockOctokit.paginate.mock.calls[0][1] as Record<string, unknown>;
        expect(params).toMatchObject({ owner: 'owner', repo: 'repo', state: 'closed' });
        expect(params).not.toHaveProperty('base');
      });

      it('passes base when given', async () => {
        mockOctokit.paginate.mockResolvedValue([]);

        await service.listMergedPullRequests('owner/repo', { base: 'main', since: new Date('2024-01-15T00:00:00Z') });

        expect(mockOctokit.paginate).toHaveBeenCalledWith(
          mockOctokit.pulls.list,
          expect.objectContaining({ base: 'main' })
        );
      });
    });

    describe('listAllRepositories', () => {
      it('paginates installation repositories for a GitHub App without the whitelist filter', async () => {
        mockRepository.findByOrganizationIdWithCredentials.mockResolvedValue(mockAppConnection);
        const appService = (await GitHubService.forOrganization('org-1', logger)) as GitHubService;
        mockOctokit.paginate.mockResolvedValue([
          { id: 1, name: 'a', full_name: 'x/a', private: false, html_url: 'u', description: null },
          { id: 2, name: 'b', full_name: 'x/b', private: true, html_url: 'u', description: 'd', archived: true },
        ]);

        const repos = await appService.listAllRepositories();

        expect(mockOctokit.paginate).toHaveBeenCalledWith(
          mockOctokit.apps.listReposAccessibleToInstallation,
          expect.objectContaining({ per_page: 100 })
        );
        expect(repos.map(r => r.full_name)).toEqual(['x/a', 'x/b']);
      });

      it('paginates the PAT owner repositories for a service account', async () => {
        mockOctokit.paginate.mockResolvedValue([]);

        await service.listAllRepositories();

        expect(mockOctokit.paginate).toHaveBeenCalledWith(
          mockOctokit.repos.listForAuthenticatedUser,
          expect.objectContaining({ per_page: 100 })
        );
      });
    });

    describe('whitelist', () => {
      it('throws GitHubRepoNotAllowedError from every repo-scoped method', async () => {
        const denied = 'other/repo';
        await expect(service.listContributors(denied)).rejects.toBeInstanceOf(GitHubRepoNotAllowedError);
        await expect(service.getCommitActivity(denied)).rejects.toBeInstanceOf(GitHubRepoNotAllowedError);
        await expect(service.listAllIssues(denied, { state: 'open' })).rejects.toBeInstanceOf(
          GitHubRepoNotAllowedError
        );
        await expect(service.getPullRequest(denied, 1)).rejects.toBeInstanceOf(GitHubRepoNotAllowedError);
        await expect(service.listCommitsByAuthor(denied, { author: 'a' })).rejects.toBeInstanceOf(
          GitHubRepoNotAllowedError
        );
      });
    });

    describe('error classification', () => {
      const failWith = (status: number, headers: Record<string, string> = {}, message = 'boom') => {
        mockOctokit.pulls.get.mockRejectedValue(
          Object.assign(new Error(message), { status, response: { headers, data: { message } } })
        );
        return service.getPullRequest('owner/repo', 1);
      };

      it('treats 429 as a rate limit', async () => {
        await expect(failWith(429)).rejects.toBeInstanceOf(GitHubRateLimitError);
      });

      it('treats 403 with remaining 0 as a rate limit and exposes the reset time', async () => {
        const error = await failWith(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }).catch(
          e => e
        );
        expect(error).toBeInstanceOf(GitHubRateLimitError);
        expect(error.resetAt).toBe(new Date(1700000000 * 1000).toISOString());
      });

      it('treats 403 with retry-after as a rate limit and exposes the delay', async () => {
        const error = await failWith(403, { 'retry-after': '30' }).catch(e => e);
        expect(error).toBeInstanceOf(GitHubRateLimitError);
        expect(error.retryAfterSeconds).toBe(30);
      });

      it('treats 403 with a rate limit message as a rate limit', async () => {
        await expect(failWith(403, {}, 'You have exceeded a secondary rate limit')).rejects.toBeInstanceOf(
          GitHubRateLimitError
        );
      });

      it('does not treat a plain 403 as a rate limit', async () => {
        const error = await failWith(403, { 'x-ratelimit-remaining': '4000' }, 'Resource not accessible').catch(e => e);
        expect(error).not.toBeInstanceOf(GitHubRateLimitError);
        expect(error).toBeInstanceOf(GitHubRequestError);
        expect(error.status).toBe(403);
      });

      it('agrees with asRateLimitedErrorOrRethrow on the same response', async () => {
        const cases: Array<[number, Record<string, string>]> = [
          [429, {}],
          [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }],
          [403, { 'retry-after': '30' }],
          [403, { 'x-ratelimit-remaining': '4000' }],
        ];
        for (const [status, headers] of cases) {
          const raw = Object.assign(new Error('boom'), { status, response: { headers, data: { message: 'boom' } } });
          const shared = (
            service as unknown as { asRateLimitedErrorOrRethrow(e: unknown): unknown }
          ).asRateLimitedErrorOrRethrow(raw) as { retryAfterSeconds?: number | null; resetAt?: string | null };
          const error = await failWith(status, headers).catch(e => e);

          expect(error instanceof GitHubRateLimitError).toBe(shared !== raw);
          if (error instanceof GitHubRateLimitError) {
            expect(error.retryAfterSeconds).toBe(shared.retryAfterSeconds ?? undefined);
            expect(error.resetAt).toBe(shared.resetAt ?? undefined);
          }
        }
      });

      it('keeps the original error as cause', async () => {
        const error = await failWith(404, {}, 'Not Found upstream').catch(e => e);
        expect(error).toBeInstanceOf(GitHubRequestError);
        expect((error.cause as Error).message).toBe('Not Found upstream');
        expect(error.message).toBe('GitHub API error (404)');
      });

      it('wraps other non-2xx responses in GitHubRequestError', async () => {
        await expect(failWith(404)).rejects.toMatchObject({ name: 'GitHubRequestError', status: 404 });
      });
    });
  });
});
