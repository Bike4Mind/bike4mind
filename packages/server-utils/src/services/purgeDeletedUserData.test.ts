import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  deleteEmbedMock,
  deleteRequestsMock,
  purgePublishedMock,
  hideAnnotationsMock,
  revokeDriveMock,
  revokeAtlassianMock,
  flagConnectionsMock,
  withdrawListingsMock,
  deleteAuthEventsMock,
  retainTracesMock,
  removeFromDetectionsMock,
  removeFromWatchesMock,
  removeFromEvalSetsMock,
  deleteLimitEventsMock,
  revoke,
} = vi.hoisted(() => ({
  revoke: {
    notion: vi.fn(),
    slack: vi.fn(),
    apple: vi.fn(),
    githubSignIn: vi.fn(),
    githubLake: vi.fn(),
    mcp: vi.fn(),
    mcpContext: vi.fn(),
  },
  deleteEmbedMock: vi.fn(),
  deleteRequestsMock: vi.fn(),
  purgePublishedMock: vi.fn(),
  hideAnnotationsMock: vi.fn(),
  revokeDriveMock: vi.fn(),
  revokeAtlassianMock: vi.fn(),
  flagConnectionsMock: vi.fn(),
  withdrawListingsMock: vi.fn(),
  deleteAuthEventsMock: vi.fn(),
  retainTracesMock: vi.fn(),
  removeFromDetectionsMock: vi.fn(),
  removeFromWatchesMock: vi.fn(),
  removeFromEvalSetsMock: vi.fn(),
  deleteLimitEventsMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {},
  authEventRepository: { deleteAllForUser: deleteAuthEventsMock },
  embedConversationRepository: { deleteAllForUser: deleteEmbedMock },
  integrationRequestRepository: { deleteAllForUser: deleteRequestsMock },
  hideDeletedAuthorAnnotations: hideAnnotationsMock,
  shadowDetectionRepository: { removeUser: removeFromDetectionsMock },
  campaignWatchRepository: { removeUser: removeFromWatchesMock },
  abuseEvalSetRepository: { removeUser: removeFromEvalSetsMock },
  userLimitEventRepository: { deleteAllForUser: deleteLimitEventsMock },
}));
vi.mock('../auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: retainTracesMock }));
vi.mock('./publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: purgePublishedMock,
}));
vi.mock('../skillMarket/market', () => ({ withdrawAuthorListings: withdrawListingsMock }));
vi.mock('../integrations/google/drive/common', () => ({
  revokeDriveGrant: revokeDriveMock,
  decryptStoredToken: (v: string | undefined) => (v ? `plain-${v}` : null),
}));
vi.mock('../integrations/google/drive/flagConnectionsStoppedByDisconnect', () => ({
  flagConnectionsStoppedByDisconnect: flagConnectionsMock,
}));
vi.mock('../integrations/jira/revokeAtlassianGrant', () => ({
  revokeAtlassianGrant: revokeAtlassianMock,
}));
vi.mock('../integrations/notion/revokeNotionGrant', () => ({ revokeNotionGrant: revoke.notion }));
vi.mock('../integrations/slack/revokeSlackUserToken', () => ({ revokeSlackUserToken: revoke.slack }));
vi.mock('../auth/revokeAppleTokens', () => ({ revokeAppleGrant: revoke.apple }));
vi.mock('../auth/revokeGitHubSignInGrant', () => ({ revokeGitHubSignInGrant: revoke.githubSignIn }));
vi.mock('../integrations/github/dataLake/githubLakeAuthGrant', () => ({
  revokeGitHubLakeUserAuthorization: revoke.githubLake,
}));
vi.mock('../mcpConnections/oauth/revoke', () => ({ revokeConnectionGrant: revoke.mcp }));
vi.mock('../mcpConnections/customMcpAccess', () => ({
  resolveCustomMcpContext: revoke.mcpContext,
  resolveOwnHosts: () => ['app.example.test'],
}));

import { purgeDeletedUserData } from './purgeDeletedUserData';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  deleteEmbedMock.mockReset().mockResolvedValue(undefined);
  deleteRequestsMock.mockReset().mockResolvedValue(0);
  purgePublishedMock.mockReset().mockResolvedValue(undefined);
  hideAnnotationsMock.mockReset().mockResolvedValue(0);
  withdrawListingsMock.mockReset().mockResolvedValue(0);
  deleteAuthEventsMock.mockReset().mockResolvedValue(0);
  removeFromDetectionsMock.mockReset().mockResolvedValue(0);
  removeFromWatchesMock.mockReset().mockResolvedValue(undefined);
  removeFromEvalSetsMock.mockReset().mockResolvedValue(0);
  retainTracesMock.mockReset().mockResolvedValue(0);
  revokeDriveMock.mockReset().mockResolvedValue('revoked');
  revokeAtlassianMock.mockReset().mockResolvedValue('revoked');
  flagConnectionsMock.mockReset().mockResolvedValue({ affectedOrgConnections: 0, affectedPersonalConnections: 0 });
  logger.error.mockReset();
  revoke.notion.mockReset().mockResolvedValue('revoked');
  revoke.slack.mockReset().mockResolvedValue('revoked');
  revoke.apple.mockReset().mockResolvedValue({ status: 'revoked' });
  revoke.githubSignIn.mockReset().mockResolvedValue('revoked');
  revoke.githubLake.mockReset().mockResolvedValue(true);
  revoke.mcp.mockReset().mockResolvedValue(undefined);
  revoke.mcpContext.mockReset().mockResolvedValue({ network: { ownHosts: ['policy.example.test'] } });
});

describe('purgeDeletedUserData', () => {
  it('purges embed history, integration requests and published artifacts for the user', async () => {
    await purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null });

    expect(deleteEmbedMock).toHaveBeenCalledWith('u1');
    expect(deleteRequestsMock).toHaveBeenCalledWith('u1');
    expect(purgePublishedMock).toHaveBeenCalledWith('u1', { deletedBy: 'admin1', logger });
    expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
    expect(withdrawListingsMock).toHaveBeenCalledWith('u1');
    expect(deleteAuthEventsMock).toHaveBeenCalledWith('u1');
    expect(removeFromDetectionsMock).toHaveBeenCalledWith('u1');
    expect(removeFromWatchesMock).toHaveBeenCalledWith('u1');
    expect(removeFromEvalSetsMock).toHaveBeenCalledWith('u1');
    expect(deleteLimitEventsMock).toHaveBeenCalledWith('u1');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when removing the user from shadow detections fails', async () => {
    removeFromDetectionsMock.mockRejectedValue(new Error('detections down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('shadow detections'));
  });

  it('logs instead of throwing when removing the user from evaluation sets fails', async () => {
    removeFromEvalSetsMock.mockRejectedValue(new Error('eval sets down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('evaluation sets'));
  });

  it('logs instead of throwing when deleting auth events fails', async () => {
    deleteAuthEventsMock.mockRejectedValue(new Error('auth events down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('delete auth events'));
  });

  it('keeps the hashed signup traces before deleting the auth events', async () => {
    retainTracesMock.mockImplementation(async () => {
      expect(deleteAuthEventsMock).not.toHaveBeenCalled();
      return 1;
    });

    await purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null });

    expect(retainTracesMock).toHaveBeenCalledWith('u1');
    expect(deleteAuthEventsMock).toHaveBeenCalledWith('u1');
  });

  it('still deletes the auth events when keeping the traces fails', async () => {
    retainTracesMock.mockRejectedValue(new Error('traces down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(deleteAuthEventsMock).toHaveBeenCalledWith('u1');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('signup traces'));
  });

  it('still hides annotations when withdrawing Skill Market listings fails, and never throws', async () => {
    withdrawListingsMock.mockRejectedValue(new Error('market down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Skill Market listings'));
    expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
  });

  it('still purges published artifacts when the embed purge fails, and never throws', async () => {
    deleteEmbedMock.mockRejectedValue(new Error('embed down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(purgePublishedMock).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('embed conversations'));
  });

  it('still purges the rest when the integration-request purge fails, and never throws', async () => {
    deleteRequestsMock.mockRejectedValue(new Error('requests down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('integration requests'));
    expect(purgePublishedMock).toHaveBeenCalled();
    expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
  });

  it('logs instead of throwing when the published-artifact purge fails', async () => {
    purgePublishedMock.mockRejectedValue(new Error('publish down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('published artifacts'));
    expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
  });

  it('logs instead of throwing when hiding annotations fails', async () => {
    hideAnnotationsMock.mockRejectedValue(new Error('annotations down'));

    await expect(
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('hide annotations'));
  });

  describe('integration grants', () => {
    const expiresAt = new Date();
    const purge = (integrationGrants: Parameters<typeof purgeDeletedUserData>[1]['integrationGrants']) =>
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants });

    it('revokes the Drive grant by its refresh token and the Atlassian token', async () => {
      await purge({
        googleDrive: { accessToken: 'enc-drive-access', refreshToken: 'enc-drive-refresh', expiresAt },
        atlassianConnect: {
          accessToken: 'enc-atl-access',
          refreshToken: 'enc-atl-refresh',
          expiresAt,
          siteName: 'site',
          resources: [],
          connectedAt: expiresAt,
        },
      });

      expect(revokeDriveMock).toHaveBeenCalledWith('enc-drive-refresh', 'deleted user u1');
      expect(flagConnectionsMock).toHaveBeenCalledWith('u1', 'plain-enc-drive-refresh');
      expect(revokeAtlassianMock).toHaveBeenNthCalledWith(1, 'enc-atl-refresh', 'deleted user u1');
      expect(revokeAtlassianMock).toHaveBeenNthCalledWith(2, 'enc-atl-access', 'deleted user u1');
    });

    it('falls back to the Drive access token when no refresh token was stored', async () => {
      await purge({ googleDrive: { accessToken: 'enc-drive-access', expiresAt }, atlassianConnect: null });

      expect(revokeDriveMock).toHaveBeenCalledWith('enc-drive-access', 'deleted user u1');
      // No refresh token means no grant an org connection could share; personal ones still stop.
      expect(flagConnectionsMock).toHaveBeenCalledWith('u1', null);
    });

    it('skips the Drive revoke when the user never connected Drive', async () => {
      await purge({ googleDrive: null, atlassianConnect: null });

      expect(revokeDriveMock).not.toHaveBeenCalled();
      expect(flagConnectionsMock).not.toHaveBeenCalled();
    });

    it('revokes only after the local purge steps, so a stalled provider cannot skip them', async () => {
      revokeDriveMock.mockImplementation(async () => {
        expect(deleteEmbedMock).toHaveBeenCalled();
        expect(deleteRequestsMock).toHaveBeenCalled();
        expect(purgePublishedMock).toHaveBeenCalled();
        expect(hideAnnotationsMock).toHaveBeenCalled();
        expect(deleteAuthEventsMock).toHaveBeenCalled();
        return 'revoked';
      });

      await purge({ googleDrive: { accessToken: 'a', refreshToken: 'r', expiresAt }, atlassianConnect: null });

      expect(revokeDriveMock).toHaveBeenCalled();
    });

    it('logs instead of throwing when the Drive flagging fails', async () => {
      flagConnectionsMock.mockRejectedValue(new Error('mongo down'));

      await expect(
        purge({ googleDrive: { accessToken: 'a', refreshToken: 'r', expiresAt }, atlassianConnect: null })
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Drive connections stopped by the revoke'));
    });

    it('still revokes Drive when the Atlassian step throws', async () => {
      revokeAtlassianMock.mockRejectedValue(new Error('boom'));

      await expect(
        purge({
          googleDrive: { accessToken: 'a', refreshToken: 'r', expiresAt },
          atlassianConnect: {
            accessToken: 'aa',
            refreshToken: 'ar',
            expiresAt,
            siteName: 'site',
            resources: [],
            connectedAt: expiresAt,
          },
        })
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Atlassian grant'));
      expect(revokeDriveMock).toHaveBeenCalledWith('r', 'deleted user u1');
      expect(flagConnectionsMock).toHaveBeenCalledWith('u1', 'plain-r');
    });

    it('still purges the rest when a revoke fails', async () => {
      revokeDriveMock.mockResolvedValue('failed');
      revokeAtlassianMock.mockResolvedValue('failed');

      await purge({ googleDrive: { accessToken: 'a', refreshToken: 'r', expiresAt }, atlassianConnect: null });

      expect(deleteEmbedMock).toHaveBeenCalledWith('u1');
      expect(deleteRequestsMock).toHaveBeenCalledWith('u1');
      expect(purgePublishedMock).toHaveBeenCalled();
      expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
    });
  });
  describe('the other provider grants', () => {
    const authProviders = [
      { strategy: 'apple', id: 'sub', refreshToken: 'enc-apple' },
      { strategy: 'github', id: '42', accessToken: 'enc-gh' },
    ] as never;
    const mcpConnections = [{ id: 'c1' }, { id: 'c2' }] as never;
    const allGrants = {
      googleDrive: null,
      atlassianConnect: null,
      notionConnect: { accessToken: 'enc-notion', workspaceId: 'w', workspaceName: 'W', botId: 'b' } as never,
      slackUserToken: 'enc-slack',
      authProviders,
      mcpConnections,
      githubLakeTokens: ['enc-lake'],
    };
    const purge = (integrationGrants: Parameters<typeof purgeDeletedUserData>[1]['integrationGrants']) =>
      purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants });

    it('revokes Notion, Slack, Apple, GitHub and every MCP grant', async () => {
      await purge(allGrants);

      expect(revoke.notion).toHaveBeenCalledWith('enc-notion', 'deleted user u1');
      expect(revoke.slack).toHaveBeenCalledWith('enc-slack', 'deleted user u1');
      expect(revoke.apple).toHaveBeenCalledWith(authProviders);
      expect(revoke.githubSignIn).toHaveBeenCalledWith(authProviders, 'deleted user u1');
      expect(revoke.githubLake).toHaveBeenCalledWith('enc-lake', 'deleted user u1');
      expect(revoke.mcpContext).toHaveBeenCalledWith('u1');
      expect(revoke.mcp).toHaveBeenCalledWith({ id: 'c1' }, { ownHosts: ['policy.example.test'] });
      expect(revoke.mcp).toHaveBeenCalledWith({ id: 'c2' }, { ownHosts: ['policy.example.test'] });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('keeps revoking the others when one provider throws, and logs the one that failed', async () => {
      revoke.apple.mockRejectedValue(new Error('Apple token revocation failed with status 400'));
      revoke.notion.mockRejectedValue(new Error('boom'));

      await expect(purge(allGrants)).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Sign in with Apple grant'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Notion grant'));
      expect(revoke.slack).toHaveBeenCalled();
      expect(revoke.githubSignIn).toHaveBeenCalled();
      expect(revoke.githubLake).toHaveBeenCalled();
      expect(revoke.mcp).toHaveBeenCalledTimes(2);
      expect(deleteEmbedMock).toHaveBeenCalledWith('u1');
    });

    it('revokes MCP grants under the default network policy when the user policy no longer resolves', async () => {
      revoke.mcpContext.mockRejectedValue(new Error('settings unavailable'));

      await purge(allGrants);

      expect(revoke.mcp).toHaveBeenCalledWith({ id: 'c1' }, { ownHosts: ['app.example.test'] });
    });

    it('calls no provider when the user held no grant', async () => {
      await purge({
        googleDrive: null,
        atlassianConnect: null,
        notionConnect: null,
        slackUserToken: null,
        authProviders: null,
        mcpConnections: [],
        githubLakeTokens: [],
      });

      for (const fn of [
        revoke.notion,
        revoke.slack,
        revoke.apple,
        revoke.githubSignIn,
        revoke.githubLake,
        revoke.mcp,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(revoke.mcpContext).not.toHaveBeenCalled();
      expect(revokeDriveMock).not.toHaveBeenCalled();
    });

    it('calls no provider when there is no grant snapshot', async () => {
      await purge(null);

      for (const fn of [
        revoke.notion,
        revoke.slack,
        revoke.apple,
        revoke.githubSignIn,
        revoke.githubLake,
        revoke.mcp,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });
});
