// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { shareable: { findAccessibleById: vi.fn() } },
}));

vi.mock('./storage/index', () => {
  const storage = { download: vi.fn() };
  return { getFilesStorage: () => storage };
});

import { fabFileRepository } from '@bike4mind/database';
import { getFilesStorage } from './storage/index';
import { ConfluenceResource, GitHubResource, JiraResource } from '@bike4mind/slack';
import { loadFabFileAttachment, resolvePendingActionTarget } from './pendingActionTarget';

const FAB_FILE_ID = 'cccccccccccccccccccccccc';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const user = { id: 'user-1' } as unknown as IUserDocument;

const findAccessibleById = vi.mocked(fabFileRepository.shareable.findAccessibleById);
const download = vi.mocked(getFilesStorage().download);

describe('loadFabFileAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    download.mockResolvedValue(Buffer.from('file-bytes'));
  });

  it('loads the base64 bytes of a serveable file, scoped to the user', async () => {
    findAccessibleById.mockResolvedValue({
      filePath: 'files/a.txt',
      mimeType: 'text/plain',
      moderationStatus: 'clean',
    } as never);

    const result = await loadFabFileAttachment(FAB_FILE_ID, user, logger);

    expect(findAccessibleById).toHaveBeenCalledWith(user, FAB_FILE_ID);
    expect(result).toEqual({
      status: 'loaded',
      content: Buffer.from('file-bytes').toString('base64'),
      mimeType: 'text/plain',
    });
  });

  it('is forbidden when the file does not resolve to one the user can access', async () => {
    findAccessibleById.mockResolvedValue(null);

    const result = await loadFabFileAttachment(FAB_FILE_ID, user, logger);

    expect(result).toEqual({ status: 'forbidden' });
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['pending', 'scanning', 'blocked', null, undefined])(
    'is unavailable, without downloading, when moderationStatus is %s',
    async moderationStatus => {
      findAccessibleById.mockResolvedValue({ filePath: 'files/a.png', moderationStatus } as never);

      const result = await loadFabFileAttachment(FAB_FILE_ID, user, logger);

      expect(result).toEqual({ status: 'unavailable' });
      expect(download).not.toHaveBeenCalled();
    }
  );

  it('is unavailable, without downloading, when the file has no stored path', async () => {
    findAccessibleById.mockResolvedValue({ moderationStatus: 'clean' } as never);

    const result = await loadFabFileAttachment(FAB_FILE_ID, user, logger);

    expect(result).toEqual({ status: 'unavailable' });
    expect(download).not.toHaveBeenCalled();
  });

  it('is unavailable when the storage download rejects', async () => {
    findAccessibleById.mockResolvedValue({ filePath: 'files/a.txt', moderationStatus: 'clean' } as never);
    download.mockRejectedValue(new Error('NoSuchKey'));

    const result = await loadFabFileAttachment(FAB_FILE_ID, user, logger);

    expect(result).toEqual({ status: 'unavailable' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('resolvePendingActionTarget', () => {
  it('routes a GitHub write tool to the GitHub server', () => {
    const target = resolvePendingActionTarget('create_issue', user, logger);

    expect(target?.mcpName).toBe('github');
    expect(target?.resource).toBeInstanceOf(GitHubResource);
  });

  it('routes a Jira write tool to a Jira resource on the Atlassian server', () => {
    const target = resolvePendingActionTarget('jira_create_issue', user, logger);

    expect(target?.mcpName).toBe('atlassian');
    expect(target?.resource).toBeInstanceOf(JiraResource);
    expect(target?.resource).not.toBeInstanceOf(ConfluenceResource);
  });

  it('routes a Confluence write tool to a Confluence resource on the Atlassian server', () => {
    const target = resolvePendingActionTarget('confluence_create_page', user, logger);

    expect(target?.mcpName).toBe('atlassian');
    expect(target?.resource).toBeInstanceOf(ConfluenceResource);
    expect(target?.resource).not.toBeInstanceOf(JiraResource);
  });

  it.each(['get_issue', 'image_generation', 'unknown_tool'])('refuses the non-confirmable tool %s', tool => {
    expect(resolvePendingActionTarget(tool, user, logger)).toBeNull();
  });
});
