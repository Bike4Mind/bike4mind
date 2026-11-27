import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSourceQueueUrl, sendToQueue, getPublishedArtifactsStorage } = vi.hoisted(() => ({
  getSourceQueueUrl: vi.fn(),
  sendToQueue: vi.fn(),
  getPublishedArtifactsStorage: vi.fn(),
}));
vi.mock('./dlqRegistry', () => ({ getSourceQueueUrl }));
vi.mock('./sqs', () => ({ sendToQueue }));
vi.mock('./storage/index', () => ({ getPublishedArtifactsStorage }));

import {
  deletePublishThumbnail,
  deletePublishThumbnails,
  enqueuePublishThumbnail,
  isPublishThumbnailKeyFor,
  publishThumbnailKey,
  publishThumbnailPrefix,
  PublishThumbnailJobSchema,
} from './publishThumbnails';

const VERSION = 'a'.repeat(64);
const QUEUE_URL = 'https://sqs.example.test/queue/publish-thumbnail';

describe('publishThumbnailKey / isPublishThumbnailKeyFor', () => {
  it('gives every render its own key under the artifact prefix', () => {
    const first = publishThumbnailKey('pub1', VERSION);
    const second = publishThumbnailKey('pub1', VERSION);
    expect(first).not.toBe(second);
    expect(first).toMatch(new RegExp(`^publish-thumbnails/pub1/${VERSION}-[0-9a-f-]{36}\\.webp$`));
    expect(isPublishThumbnailKeyFor('pub1', first)).toBe(true);
    expect(isPublishThumbnailKeyFor('pub1', second)).toBe(true);
  });

  it('preserves legacy version-only keys for existing records', () => {
    expect(isPublishThumbnailKeyFor('pub1', `publish-thumbnails/pub1/${VERSION}.webp`)).toBe(true);
  });

  it.each(['../other', 'not-a-uuid', '00000000-0000-0000-0000-00000000000z'])(
    'rejects invalid render ids %s',
    renderId => {
      expect(isPublishThumbnailKeyFor('pub1', publishThumbnailKey('pub1', VERSION, renderId))).toBe(false);
    }
  );

  it("accepts only the artifact's own thumbnail keys", () => {
    expect(isPublishThumbnailKeyFor('pub1', publishThumbnailKey('pub1', VERSION))).toBe(true);
    expect(isPublishThumbnailKeyFor('pub1', publishThumbnailKey('pub2', VERSION))).toBe(false);
    expect(isPublishThumbnailKeyFor('pub1', `publish-thumbnails/pub1x/${VERSION}.webp`)).toBe(false);
    expect(isPublishThumbnailKeyFor('pub1', `publish-thumbnails/pub1/../pub2/${VERSION}.webp`)).toBe(false);
    expect(isPublishThumbnailKeyFor('pub1', 'user/scope/slug/index.html')).toBe(false);
  });
});

describe('PublishThumbnailJobSchema', () => {
  it('rejects ids that could escape the key prefix and non-sha versions', () => {
    expect(PublishThumbnailJobSchema.safeParse({ publicId: 'pub1', versionId: VERSION }).success).toBe(true);
    expect(PublishThumbnailJobSchema.safeParse({ publicId: '../x', versionId: VERSION }).success).toBe(false);
    expect(PublishThumbnailJobSchema.safeParse({ publicId: 'a/b', versionId: VERSION }).success).toBe(false);
    expect(PublishThumbnailJobSchema.safeParse({ publicId: 'pub1', versionId: 'v1' }).success).toBe(false);
  });
});

describe('enqueuePublishThumbnail', () => {
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    getSourceQueueUrl.mockReturnValue(QUEUE_URL);
    sendToQueue.mockResolvedValue(undefined);
  });

  it('sends the validated job to the thumbnail queue', async () => {
    await expect(enqueuePublishThumbnail({ publicId: 'pub1', versionId: VERSION }, logger)).resolves.toBe(true);
    expect(getSourceQueueUrl).toHaveBeenCalledWith('publishThumbnailQueue');
    expect(sendToQueue).toHaveBeenCalledWith(QUEUE_URL, { publicId: 'pub1', versionId: VERSION });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves false and warns when the send fails, never throwing', async () => {
    sendToQueue.mockRejectedValue(new Error('throttled'));
    await expect(enqueuePublishThumbnail({ publicId: 'pub1', versionId: VERSION }, logger)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
  });

  it('resolves false quietly when no queue is provisioned (self-host)', async () => {
    getSourceQueueUrl.mockImplementation(() => {
      throw new Error('missing');
    });
    await expect(enqueuePublishThumbnail({ publicId: 'pub1', versionId: VERSION }, logger)).resolves.toBe(false);
    expect(sendToQueue).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refuses an invalid job without touching the queue', async () => {
    await expect(enqueuePublishThumbnail({ publicId: 'pub1', versionId: 'nope' }, logger)).resolves.toBe(false);
    expect(sendToQueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid job'));
  });
});

describe('deletePublishThumbnails', () => {
  const logger = { warn: vi.fn() };
  const deletePrefix = vi.fn();

  beforeEach(() => {
    logger.warn.mockReset();
    deletePrefix.mockReset().mockResolvedValue(2);
    getPublishedArtifactsStorage.mockReset().mockReturnValue({ deletePrefix });
  });

  it("deletes every object under each artifact's own thumbnail folder", async () => {
    await expect(deletePublishThumbnails(['pub1', 'pub2'], logger)).resolves.toBe(4);
    expect(deletePrefix.mock.calls.map(([prefix]) => prefix).sort()).toEqual([
      'publish-thumbnails/pub1/',
      'publish-thumbnails/pub2/',
    ]);
    expect(publishThumbnailPrefix('pub1')).toBe('publish-thumbnails/pub1/');
  });

  it('skips ids that could not have formed a key, and de-duplicates the rest', async () => {
    await deletePublishThumbnails(['pub1', 'pub1', '', '../x', 'a/b'], logger);
    expect(deletePrefix).toHaveBeenCalledTimes(1);
    expect(deletePrefix).toHaveBeenCalledWith('publish-thumbnails/pub1/');
  });

  it('does not touch storage when there is nothing to delete', async () => {
    await expect(deletePublishThumbnails([], logger)).resolves.toBe(0);
    expect(getPublishedArtifactsStorage).not.toHaveBeenCalled();
  });

  it('logs a failed artifact and still deletes the others, never throwing', async () => {
    deletePrefix.mockImplementation(async (prefix: string) => {
      if (prefix.includes('bad')) throw new Error('AccessDenied');
      return 1;
    });
    await expect(deletePublishThumbnails(['bad', 'good'], logger)).resolves.toBe(1);
    expect(deletePrefix).toHaveBeenCalledWith('publish-thumbnails/good/');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad'));
  });

  it('logs and resolves when the storage itself is unavailable', async () => {
    getPublishedArtifactsStorage.mockImplementation(() => {
      throw new Error('bucket not linked');
    });
    await expect(deletePublishThumbnails(['pub1'], logger)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bucket not linked'));
  });
});

describe('deletePublishThumbnail', () => {
  const logger = { warn: vi.fn() };
  const deleteObject = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    deleteObject.mockResolvedValue(undefined);
    getPublishedArtifactsStorage.mockReturnValue({ delete: deleteObject });
  });

  it('deletes only the detached object, never the folder containing a restored render', async () => {
    const key = publishThumbnailKey('pub1', VERSION);
    await deletePublishThumbnail('pub1', key, logger);
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith(key);
  });

  it('refuses another artifact or non-thumbnail key without touching storage', async () => {
    await deletePublishThumbnail('pub1', publishThumbnailKey('pub2', VERSION), logger);
    await deletePublishThumbnail('pub1', 'user/scope/slug/index.html', logger);
    expect(getPublishedArtifactsStorage).not.toHaveBeenCalled();
  });

  it('logs and swallows a storage error', async () => {
    deleteObject.mockRejectedValue(new Error('AccessDenied'));
    await expect(deletePublishThumbnail('pub1', publishThumbnailKey('pub1', VERSION), logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
  });
});
