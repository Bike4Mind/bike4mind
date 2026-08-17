import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';

/**
 * `createFabFileByUrl` had no tests. These cover the tag/provenance pass-through added for LINK
 * ingest, and - the load-bearing one - that neither can be supplied through the parsed request
 * body, only by a server-side caller that has already run the lake write gate.
 */

const fetchAndParseURL = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  fetchAndParseURL,
}));

import { createFabFileByUrl } from './createByUrl';

const URL_UNDER_TEST = 'https://example.com/article';

let fabFilesCreate: Mock;
let storageUpload: Mock;

function adapters() {
  return {
    db: {
      fabFiles: { create: fabFilesCreate },
      adminSettings: {
        findAll: vi.fn().mockResolvedValue([]),
        findBySettingNames: vi.fn().mockResolvedValue([]),
      } as never,
      users: {
        findById: vi.fn().mockResolvedValue({ id: 'user-1', storageLimit: 1_000_000, currentStorageSize: 0 } as never),
      },
    },
    storage: {
      upload: storageUpload,
      generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
  storageUpload = vi.fn().mockResolvedValue(undefined);
  fetchAndParseURL.mockResolvedValue({
    title: 'An Article',
    textContent: 'body text',
    mimeType: 'text/plain',
    ext: 'txt',
  });
});

describe('createFabFileByUrl', () => {
  it('creates a URL-type file from the fetched content and uploads it', async () => {
    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    expect(fetchAndParseURL).toHaveBeenCalledWith(URL_UNDER_TEST, expect.anything());
    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.fileName).toBe('An Article');
    expect(created.type).toBe(KnowledgeType.URL);
    expect(created.fileSize).toBe(Buffer.byteLength('body text'));
    // Uploaded to the path createFabFile allocated, so S3 ObjectCreated picks it up as usual.
    expect(storageUpload).toHaveBeenCalledWith(created.filePath, 'body text', { ContentType: 'text/plain' });
    expect(result.id).toBe('fab-1');
  });

  it('stamps adapter-supplied tags on the created file', async () => {
    const tags = [{ name: 'lake:demo', strength: 1 }];

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), tags });

    expect(fabFilesCreate.mock.calls[0][0].tags).toEqual(tags);
  });

  it('stamps adapter-supplied provenance on the created file', async () => {
    await createFabFileByUrl(
      'user-1',
      { url: URL_UNDER_TEST },
      {
        ...adapters(),
        provenance: {
          sourceType: FabFileSourceType.SLACK,
          sourceMetadata: { channel: 'C1', messageTs: '1700000000.0001', sourceUrl: URL_UNDER_TEST },
        },
      }
    );

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.sourceType).toBe(FabFileSourceType.SLACK);
    expect(created.sourceMetadata).toEqual({
      channel: 'C1',
      messageTs: '1700000000.0001',
      sourceUrl: URL_UNDER_TEST,
    });
  });

  it('sets no tags or provenance when the caller supplies none (the web URL door, unchanged)', async () => {
    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.tags).toBeUndefined();
    expect(created.sourceType).toBeUndefined();
    expect(created.sourceMetadata).toBeUndefined();
  });

  it('IGNORES tags and provenance smuggled through the request body', async () => {
    // The security property: `createFabFileByUrlSchema` is parsed from an HTTP body, so a caller
    // must not be able to put a file into a data lake by naming its meta-tag, nor forge a Slack
    // origin. Both are adapters precisely so this cannot work.
    await createFabFileByUrl(
      'user-1',
      {
        url: URL_UNDER_TEST,
        tags: [{ name: 'lake:private', strength: 1 }],
        provenance: { sourceType: FabFileSourceType.SLACK },
      } as never,
      adapters()
    );

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.tags).toBeUndefined();
    expect(created.sourceType).toBeUndefined();
  });

  it('rejects a Google Drive link before fetching anything', async () => {
    await expect(
      createFabFileByUrl('user-1', { url: 'https://drive.google.com/file/d/abcdefghij/view' }, adapters())
    ).rejects.toThrow();

    expect(fetchAndParseURL).not.toHaveBeenCalled();
  });
});

/**
 * The row is created BEFORE its bytes are uploaded. An un-transactioned caller (the Slack link path)
 * therefore needs a compensating delete, or a failed upload strands a file that can never be indexed:
 * chunk/vectorize runs off the S3 ObjectCreated event, which never fires for an object that was never
 * written.
 */
describe('createFabFileByUrl upload failure', () => {
  it('deletes the created file and rethrows the upload error', async () => {
    storageUpload.mockRejectedValue(new Error('S3 unavailable'));
    const deleteCreatedFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never)
    ).rejects.toThrow(/S3 unavailable/);

    expect(deleteCreatedFile).toHaveBeenCalledWith('fab-1');
  });

  it('still surfaces the UPLOAD error when the compensating delete also fails', async () => {
    // The cleanup failure must not mask the real cause, or the caller reports the wrong thing.
    storageUpload.mockRejectedValue(new Error('S3 unavailable'));
    const deleteCreatedFile = vi.fn().mockRejectedValue(new Error('mongo unreachable'));

    await expect(
      createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never)
    ).rejects.toThrow(/S3 unavailable/);
  });

  it('does not attempt cleanup when the upload succeeds', async () => {
    const deleteCreatedFile = vi.fn();

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never);

    expect(deleteCreatedFile).not.toHaveBeenCalled();
  });
});
