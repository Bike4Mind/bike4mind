import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies using vi.hoisted
const { mockOctokit, mockRepository, mockConfig, mockDecryptSecret, mockEncryptSecret, mockIsEncrypted, mockLogger } =
  vi.hoisted(() => ({
    mockOctokit: {
      paginate: vi.fn(),
      issues: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        createComment: vi.fn(),
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
      },
      apps: {
        getAuthenticated: vi.fn(),
        listReposAccessibleToInstallation: vi.fn(),
      },
      users: {
        getAuthenticated: vi.fn(),
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
    mockDecryptSecret: vi.fn((val: string) => val),
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
vi.mock('@server/utils/config', () => ({
  Config: mockConfig,
}));

// Mock secret encryption
vi.mock('@server/security/secretEncryption', () => ({
  decryptSecret: mockDecryptSecret,
  encryptSecret: mockEncryptSecret,
  isEncrypted: mockIsEncrypted,
}));

// Mock @bike4mind/common
vi.mock('@bike4mind/common', () => ({
  parseRateLimitHeaders: vi.fn(() => ({
    limit: 5000,
    remaining: 4999,
    resetAt: new Date(),
    retryAfterMs: null,
    usagePercent: 0,
  })),
  isNearLimit: vi.fn(() => false),
  buildRateLimitLogEntry: vi.fn(() => ({})),
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));

import { GitHubService, GitHubRateLimitError } from './githubService';
import { Logger } from '@bike4mind/observability';

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

      it('should throw if SECRET_ENCRYPTION_KEY is not configured', async () => {
        mockConfig.SECRET_ENCRYPTION_KEY = '';
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow('GitHub service configuration error');
      });

      it('should throw on auth init failure so the caller can retry (transient failure)', async () => {
        mockRepository.findSystemDefaultWithCredentials.mockResolvedValue({
          ...mockConnection,
          isSystemDefault: true,
        });
        // Mark the token as encrypted so decryptSecret is actually called,
        // then make decryption blow up to simulate an auth init failure.
        mockIsEncrypted.mockReturnValueOnce(true);
        mockDecryptSecret.mockImplementationOnce(() => {
          throw new Error('decryption failed');
        });

        await expect(GitHubService.forSystem(logger)).rejects.toThrow(
          '[GitHubService] Failed to initialize GitHub authentication'
        );
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
        const result = await service.testConnection();

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
        const result = await service.testConnection();

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
      const result = await service.testConnection();

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
});
