import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSourceQueueUrl, sendToQueue } = vi.hoisted(() => ({
  getSourceQueueUrl: vi.fn(),
  sendToQueue: vi.fn(),
}));
vi.mock('./dlqRegistry', () => ({ getSourceQueueUrl }));
vi.mock('./sqs', () => ({ sendToQueue }));

import {
  enqueuePublishThumbnail,
  isPublishThumbnailKeyFor,
  publishThumbnailKey,
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
