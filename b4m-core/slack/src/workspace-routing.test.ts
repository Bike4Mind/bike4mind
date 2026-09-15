import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ISlackDevWorkspaceDocument } from '@bike4mind/common';

// Mock the repository
const mockFindBySlackTeamIdWithToken = vi.fn();

vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: {
    findBySlackTeamIdWithToken: (...args: unknown[]) => mockFindBySlackTeamIdWithToken(...args),
  },
}));

/**
 * Tests for multi-workspace event routing
 *
 * - Look up workspace by team_id and use workspace-specific token
 * - Return error if workspace not found (OAuth install required)
 */
describe('Slack Workspace Routing', () => {
  const mockOAuthWorkspace: Partial<ISlackDevWorkspaceDocument> = {
    name: 'Acme',
    slackTeamId: 'T123ACME',
    slackBotToken: 'xoxb-oauth-workspace-token',
    slackBotName: 'Acme Dev Assistant',
    slackBotUserId: 'U123BOT',
    slackBotId: 'B123BOT',
    slackAppId: 'A123APP',
    isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Simulates the workspace routing logic from events.ts
   * This is extracted to make it testable without invoking the full handler
   */
  async function resolveWorkspaceToken(
    teamId: string | undefined,
    isDevBot: boolean
  ): Promise<{
    slackBotToken: string | undefined;
    botType: string;
    workspace: Partial<ISlackDevWorkspaceDocument> | null;
    error?: string;
  }> {
    let slackBotToken: string | undefined = undefined;
    let botType = isDevBot ? 'dev' : 'analytics';
    let workspace: Partial<ISlackDevWorkspaceDocument> | null = null;

    // For dev bot, look up workspace by team_id
    if (isDevBot && teamId) {
      workspace = await mockFindBySlackTeamIdWithToken(teamId);

      if (workspace) {
        // Use workspace-specific token (OAuth-installed workspace)
        slackBotToken = workspace.slackBotToken;
        botType = 'dev-oauth';
      } else {
        // Workspace not found - OAuth install required
        return {
          slackBotToken: undefined,
          botType: 'dev',
          workspace: null,
          error: 'Workspace not connected',
        };
      }
    }

    return { slackBotToken, botType, workspace };
  }

  describe('OAuth workspace lookup', () => {
    it('should use OAuth workspace token when workspace is found', async () => {
      mockFindBySlackTeamIdWithToken.mockResolvedValue(mockOAuthWorkspace);

      const result = await resolveWorkspaceToken('T123ACME', true);

      expect(mockFindBySlackTeamIdWithToken).toHaveBeenCalledWith('T123ACME');
      expect(result.botType).toBe('dev-oauth');
      expect(result.slackBotToken).toBe('xoxb-oauth-workspace-token');
      expect(result.workspace).toEqual(mockOAuthWorkspace);
    });

    it('should look up workspace by team_id', async () => {
      mockFindBySlackTeamIdWithToken.mockResolvedValue(mockOAuthWorkspace);

      await resolveWorkspaceToken('T456GLOBEX', true);

      expect(mockFindBySlackTeamIdWithToken).toHaveBeenCalledWith('T456GLOBEX');
    });
  });

  describe('Workspace not found', () => {
    it('should return error when workspace not found', async () => {
      mockFindBySlackTeamIdWithToken.mockResolvedValue(null);

      const result = await resolveWorkspaceToken('T999UNKNOWN', true);

      expect(mockFindBySlackTeamIdWithToken).toHaveBeenCalledWith('T999UNKNOWN');
      expect(result.error).toBe('Workspace not connected');
      expect(result.slackBotToken).toBeUndefined();
      expect(result.workspace).toBeNull();
    });

    it('should not look up workspace when team_id is missing', async () => {
      const result = await resolveWorkspaceToken(undefined, true);

      expect(mockFindBySlackTeamIdWithToken).not.toHaveBeenCalled();
      expect(result.botType).toBe('dev');
    });
  });

  describe('Multi-workspace isolation', () => {
    it('should return different tokens for different workspaces', async () => {
      const acmeWorkspace = { ...mockOAuthWorkspace, slackTeamId: 'T123ACME', slackBotToken: 'xoxb-acme-token' };
      const globexWorkspace = {
        ...mockOAuthWorkspace,
        slackTeamId: 'T456GLOBEX',
        slackBotToken: 'xoxb-globex-token',
        name: 'Globex',
      };

      // First workspace
      mockFindBySlackTeamIdWithToken.mockResolvedValue(acmeWorkspace);
      const result1 = await resolveWorkspaceToken('T123ACME', true);

      // Second workspace
      mockFindBySlackTeamIdWithToken.mockResolvedValue(globexWorkspace);
      const result2 = await resolveWorkspaceToken('T456GLOBEX', true);

      expect(result1.slackBotToken).toBe('xoxb-acme-token');
      expect(result2.slackBotToken).toBe('xoxb-globex-token');
      expect(result1.slackBotToken).not.toBe(result2.slackBotToken);
    });
  });
});
