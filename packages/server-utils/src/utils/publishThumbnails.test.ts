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
  it('builds the per-version key under the dedicated prefix', () => {
    expect(publishThumbnailKey('pub1', VERSION)).toBe(`publish-thumbnails/pub1/${VERSION}.webp`);
  });

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
