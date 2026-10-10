import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteEmbedMock, purgePublishedMock } = vi.hoisted(() => ({
  deleteEmbedMock: vi.fn(),
  purgePublishedMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  embedConversationRepository: { deleteAllForUser: deleteEmbedMock },
}));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: purgePublishedMock,
}));

import { purgeDeletedUserData } from './purgeDeletedUserData';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  deleteEmbedMock.mockReset().mockResolvedValue(undefined);
  purgePublishedMock.mockReset().mockResolvedValue(undefined);
  logger.error.mockReset();
});

describe('purgeDeletedUserData', () => {
  it('purges embed history and published artifacts for the user', async () => {
    await purgeDeletedUserData('u1', { deletedBy: 'admin1', logger });

    expect(deleteEmbedMock).toHaveBeenCalledWith('u1');
    expect(purgePublishedMock).toHaveBeenCalledWith('u1', { deletedBy: 'admin1', logger });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still purges published artifacts when the embed purge fails, and never throws', async () => {
    deleteEmbedMock.mockRejectedValue(new Error('embed down'));

    await expect(purgeDeletedUserData('u1', { deletedBy: 'admin1', logger })).resolves.toBeUndefined();

    expect(purgePublishedMock).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('embed conversations'));
  });

  it('logs instead of throwing when the published-artifact purge fails', async () => {
    purgePublishedMock.mockRejectedValue(new Error('publish down'));

    await expect(purgeDeletedUserData('u1', { deletedBy: 'admin1', logger })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('published artifacts'));
  });
});
