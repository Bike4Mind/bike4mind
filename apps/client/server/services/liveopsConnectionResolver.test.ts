import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const {
  mockFindByOrganizationIdWithToken,
  mockFindByIdWithToken,
  mockFindAllActive,
  mockFindBySlackTeamIdWithToken,
  mockFindJiraByOrganizationIdWithCredentials,
} = vi.hoisted(() => ({
  mockFindByOrganizationIdWithToken: vi.fn(),
  mockFindByIdWithToken: vi.fn(),
  mockFindAllActive: vi.fn(),
  mockFindBySlackTeamIdWithToken: vi.fn(),
  mockFindJiraByOrganizationIdWithCredentials: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgSlackWorkspaceRepository: {
    findByOrganizationIdWithToken: mockFindByOrganizationIdWithToken,
  },
  slackDevWorkspaceRepository: {
    findByIdWithToken: mockFindByIdWithToken,
    findAllActive: mockFindAllActive,
    findBySlackTeamIdWithToken: mockFindBySlackTeamIdWithToken,
  },
  orgJiraConnectionRepository: {
    findByOrganizationIdWithCredentials: mockFindJiraByOrganizationIdWithCredentials,
  },
}));

// Tokens pass through decryption verbatim so assertions can trace which
// connection a token came from.
vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: (value: string | null | undefined) => value ?? null,
}));

vi.mock('@server/security/secretEncryption', () => ({
  isEncrypted: (value: string) => value.startsWith('enc:'),
  decryptSecret: (value: string) => value.replace(/^enc:/, ''),
}));

vi.mock('@server/utils/config', () => ({
  Config: { SECRET_ENCRYPTION_KEY: 'test-key' },
}));

import { resolveSlackBotToken, resolveJiraConfig } from './liveopsConnectionResolver';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSlackBotToken', () => {
  describe('org-scoped configs', () => {
    it('resolves each org to its own workspace token (no cross-talk)', async () => {
      mockFindByOrganizationIdWithToken.mockImplementation(async (orgId: string) =>
        orgId === 'org-a'
          ? { organizationId: 'org-a', slackBotToken: 'xoxb-org-a' }
          : { organizationId: 'org-b', slackBotToken: 'xoxb-org-b' }
      );

      const tokenA = await resolveSlackBotToken({ organizationId: 'org-a', name: 'a' }, mockLogger);
      const tokenB = await resolveSlackBotToken({ organizationId: 'org-b', name: 'b' }, mockLogger);

      expect(tokenA).toBe('xoxb-org-a');
      expect(tokenB).toBe('xoxb-org-b');
      // Org configs never consult system-level (dev) workspaces
      expect(mockFindByIdWithToken).not.toHaveBeenCalled();
      expect(mockFindAllActive).not.toHaveBeenCalled();
    });

    it('returns null with no system-level fallback when the org has no workspace', async () => {
      mockFindByOrganizationIdWithToken.mockResolvedValue(null);
      mockFindAllActive.mockResolvedValue([{ id: 'ws-1', slackTeamId: 'T123' }]);

      const token = await resolveSlackBotToken({ organizationId: 'org-a', name: 'a' }, mockLogger);

      expect(token).toBeNull();
      expect(mockFindAllActive).not.toHaveBeenCalled();
      expect(mockFindBySlackTeamIdWithToken).not.toHaveBeenCalled();
    });

    it('ignores slackWorkspaceId (dev workspace) for org-scoped configs', async () => {
      mockFindByOrganizationIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-org-a' });

      const token = await resolveSlackBotToken(
        { organizationId: 'org-a', slackWorkspaceId: 'dev-ws-id' as never, name: 'a' },
        mockLogger
      );

      expect(token).toBe('xoxb-org-a');
      expect(mockFindByIdWithToken).not.toHaveBeenCalled();
    });
  });

  describe('legacy configs (no organizationId)', () => {
    it('uses the configured dev workspace', async () => {
      mockFindByIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-legacy' });

      const token = await resolveSlackBotToken({ slackWorkspaceId: 'dev-ws-id' as never, name: 'legacy' }, mockLogger);

      expect(token).toBe('xoxb-legacy');
      expect(mockFindByOrganizationIdWithToken).not.toHaveBeenCalled();
    });

    it('falls back to the first active workspace', async () => {
      mockFindAllActive.mockResolvedValue([{ id: 'ws-1', slackTeamId: 'T123' }]);
      mockFindBySlackTeamIdWithToken.mockResolvedValue({ slackBotToken: 'xoxb-fallback' });

      const token = await resolveSlackBotToken({ name: 'legacy' }, mockLogger);

      expect(token).toBe('xoxb-fallback');
    });
  });
});

describe('resolveJiraConfig', () => {
  it('builds each org Jira config from its own connection (no cross-talk)', async () => {
    mockFindJiraByOrganizationIdWithCredentials.mockImplementation(async (orgId: string) =>
      orgId === 'org-a'
        ? { accessToken: 'enc:token-a', cloudId: 'cloud-a', siteUrl: 'https://org-a.atlassian.net' }
        : { accessToken: 'enc:token-b', cloudId: 'cloud-b', siteUrl: 'https://org-b.atlassian.net' }
    );

    const configA = await resolveJiraConfig('org-a', mockLogger);
    const configB = await resolveJiraConfig('org-b', mockLogger);

    expect(configA.accessToken).toBe('token-a');
    expect(configA.apiBaseUrl).toContain('cloud-a');
    expect(configB.accessToken).toBe('token-b');
    expect(configB.apiBaseUrl).toContain('cloud-b');
  });

  it('throws (no env fallback) when the org has no Jira connection', async () => {
    mockFindJiraByOrganizationIdWithCredentials.mockResolvedValue(null);

    await expect(resolveJiraConfig('org-a', mockLogger)).rejects.toThrow(
      'No enabled Jira connection found for organization'
    );
  });

  it('uses ATLASSIAN_* environment config for legacy configs', async () => {
    vi.stubEnv('ATLASSIAN_ACCESS_TOKEN', 'env-token');
    vi.stubEnv('ATLASSIAN_CLOUD_ID', 'env-cloud');
    vi.stubEnv('ATLASSIAN_SITE_URL', 'https://system.atlassian.net');

    try {
      const config = await resolveJiraConfig(undefined, mockLogger);

      expect(config.accessToken).toBe('env-token');
      expect(config.apiBaseUrl).toContain('env-cloud');
      expect(mockFindJiraByOrganizationIdWithCredentials).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
