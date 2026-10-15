import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  deleteEmbedMock,
  deleteRequestsMock,
  purgePublishedMock,
  hideAnnotationsMock,
  revokeDriveMock,
  revokeAtlassianMock,
  flagConnectionsMock,
} = vi.hoisted(() => ({
  deleteEmbedMock: vi.fn(),
  deleteRequestsMock: vi.fn(),
  purgePublishedMock: vi.fn(),
  hideAnnotationsMock: vi.fn(),
  revokeDriveMock: vi.fn(),
  revokeAtlassianMock: vi.fn(),
  flagConnectionsMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {},
  embedConversationRepository: { deleteAllForUser: deleteEmbedMock },
  integrationRequestRepository: { deleteAllForUser: deleteRequestsMock },
  hideDeletedAuthorAnnotations: hideAnnotationsMock,
}));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: purgePublishedMock,
}));
vi.mock('@server/integrations/google/drive/common', () => ({
  revokeDriveGrant: revokeDriveMock,
  decryptStoredToken: (v: string | undefined) => (v ? `plain-${v}` : null),
}));
vi.mock('@server/integrations/google/drive/flagConnectionsStoppedByDisconnect', () => ({
  flagConnectionsStoppedByDisconnect: flagConnectionsMock,
}));
vi.mock('@server/integrations/jira/revokeAtlassianGrant', () => ({ revokeAtlassianGrant: revokeAtlassianMock }));

import { purgeDeletedUserData } from './purgeDeletedUserData';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  deleteEmbedMock.mockReset().mockResolvedValue(undefined);
  deleteRequestsMock.mockReset().mockResolvedValue(0);
  purgePublishedMock.mockReset().mockResolvedValue(undefined);
  hideAnnotationsMock.mockReset().mockResolvedValue(0);
  revokeDriveMock.mockReset().mockResolvedValue('revoked');
  revokeAtlassianMock.mockReset().mockResolvedValue('revoked');
  flagConnectionsMock.mockReset().mockResolvedValue({ affectedOrgConnections: 0, affectedPersonalConnections: 0 });
  logger.error.mockReset();
});

describe('purgeDeletedUserData', () => {
  it('purges embed history, integration requests and published artifacts for the user', async () => {
    await purgeDeletedUserData('u1', { deletedBy: 'admin1', logger, integrationGrants: null });

    expect(deleteEmbedMock).toHaveBeenCalledWith('u1');
    expect(deleteRequestsMock).toHaveBeenCalledWith('u1');
    expect(purgePublishedMock).toHaveBeenCalledWith('u1', { deletedBy: 'admin1', logger });
    expect(hideAnnotationsMock).toHaveBeenCalledWith('u1');
    expect(logger.error).not.toHaveBeenCalled();
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
});
