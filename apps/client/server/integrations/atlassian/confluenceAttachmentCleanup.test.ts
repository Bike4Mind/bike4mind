// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const confluenceApi = vi.hoisted(() => ({ getPageStorage: vi.fn(), updatePage: vi.fn() }));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  ConfluenceApi: vi.fn(function ConfluenceApiStub() {
    return confluenceApi;
  }),
}));

import { cleanupConfluencePageContent, removeAttachmentMacros } from './confluenceAttachmentCleanup';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const env = [
  { key: 'ATLASSIAN_ACCESS_TOKEN', value: 'token' },
  { key: 'ATLASSIAN_CLOUD_ID', value: 'cloud' },
  { key: 'ATLASSIAN_SITE_URL', value: 'https://example.atlassian.net' },
];

const IMAGE_MACRO = '<p><ac:image><ri:attachment ri:filename="pic.png" /></ac:image></p>';

describe('cleanupConfluencePageContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['123/../../x', '123?foo=bar', ''])('makes no API call for page id %j', async pageId => {
    await cleanupConfluencePageContent(env, pageId, 'pic.png', logger);

    expect(confluenceApi.getPageStorage).not.toHaveBeenCalled();
    expect(confluenceApi.updatePage).not.toHaveBeenCalled();
  });

  it('reads the page and writes it back with the attachment macros removed', async () => {
    confluenceApi.getPageStorage.mockResolvedValue({
      title: 'Page',
      version: 3,
      storage: `<p>keep</p>${IMAGE_MACRO}`,
    });

    await cleanupConfluencePageContent(env, '123', 'pic.png', logger);

    expect(confluenceApi.getPageStorage).toHaveBeenCalledWith({ pageId: '123' });
    expect(confluenceApi.updatePage).toHaveBeenCalledWith({
      pageId: '123',
      title: 'Page',
      content: '<p>keep</p>',
      expectedVersion: 3,
    });
  });

  it('does not update a page that has no macro for the attachment', async () => {
    confluenceApi.getPageStorage.mockResolvedValue({ title: 'Page', version: 3, storage: '<p>keep</p>' });

    await cleanupConfluencePageContent(env, '123', 'pic.png', logger);

    expect(confluenceApi.updatePage).not.toHaveBeenCalled();
  });

  it('writes an empty paragraph when the macro was the whole page body', async () => {
    confluenceApi.getPageStorage.mockResolvedValue({ title: 'Page', version: 3, storage: IMAGE_MACRO });

    await cleanupConfluencePageContent(env, '123', 'pic.png', logger);

    expect(confluenceApi.updatePage).toHaveBeenCalledWith({
      pageId: '123',
      title: 'Page',
      content: '<p></p>',
      expectedVersion: 3,
    });
  });
});

describe('removeAttachmentMacros', () => {
  it('removes image macros for the named file only', () => {
    const other = '<ac:image><ri:attachment ri:filename="other.png" /></ac:image>';
    expect(removeAttachmentMacros(`${IMAGE_MACRO}${other}`, 'pic.png')).toBe(other);
  });
});
