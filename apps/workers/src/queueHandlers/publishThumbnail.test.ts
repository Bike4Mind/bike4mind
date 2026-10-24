import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  recordPublishedArtifactThumbnail: vi.fn(),
  storage: { download: vi.fn(), upload: vi.fn(), delete: vi.fn() },
  buildThumbnailDocument: vi.fn(),
  renderHtmlThumbnail: vi.fn(),
  openLambdaChromiumContext: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: h.findOne },
  recordPublishedArtifactThumbnail: h.recordPublishedArtifactThumbnail,
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => h.storage,
}));
vi.mock('@server/services/publish/buildThumbnailDocument', () => ({
  buildThumbnailDocument: h.buildThumbnailDocument,
}));
vi.mock('@workers/media/launchLambdaChromium', () => ({
  openLambdaChromiumContext: h.openLambdaChromiumContext,
}));
vi.mock('@workers/media/renderHtmlThumbnail', async importOriginal => ({
  ...(await importOriginal<typeof import('@workers/media/renderHtmlThumbnail')>()),
  renderHtmlThumbnail: h.renderHtmlThumbnail,
}));

import { dispatch, processPublishThumbnailJob } from './publishThumbnail';
import { ThumbnailRenderTimeoutError } from '@workers/media/renderHtmlThumbnail';

const VERSION = 'b'.repeat(64);
const OLD_VERSION = 'c'.repeat(64);
const KEY = `publish-thumbnails/pub1/${VERSION}.webp`;
const OLD_KEY = `publish-thumbnails/pub1/${OLD_VERSION}.webp`;
const IMAGE = Buffer.from('webp-bytes');
const job = { publicId: 'pub1', versionId: VERSION };

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

const lean = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
const bundleArtifact = (over: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  source: { kind: 'bundle' },
  storageKeyPrefix: 'user/owner1/my-slug/',
  sha256Index: VERSION,
  manifest: [{ path: 'index.html', mimeType: 'text/html' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findOne.mockReturnValue(lean(bundleArtifact()));
  h.buildThumbnailDocument.mockResolvedValue({ srcdoc: '<h1>x</h1>', allowedScriptUrls: [], droppedAssets: [] });
  h.renderHtmlThumbnail.mockResolvedValue(IMAGE);
  h.storage.upload.mockResolvedValue(undefined);
  h.storage.delete.mockResolvedValue(undefined);
  h.storage.download.mockResolvedValue(Buffer.from('<h1>x</h1>'));
  h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: null });
});

describe('processPublishThumbnailJob', () => {
  it('renders from storage, uploads to the private thumbnail key and records it', async () => {
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('rendered');

    expect(h.findOne).toHaveBeenCalledWith({ publicId: 'pub1', deletedAt: null });
    const docInput = h.buildThumbnailDocument.mock.calls[0][0];
    expect(docInput.versionId).toBe(VERSION);
    await docInput.load('style.css');
    expect(h.storage.download).toHaveBeenCalledWith('user/owner1/my-slug/style.css');
    expect(h.renderHtmlThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ srcdoc: '<h1>x</h1>', openContext: h.openLambdaChromiumContext })
    );
    expect(h.storage.upload).toHaveBeenCalledWith(IMAGE, KEY, {
      ContentType: 'image/webp',
      CacheControl: 'private, max-age=31536000, immutable',
    });
    expect(h.recordPublishedArtifactThumbnail).toHaveBeenCalledWith('pub1', {
      key: KEY,
      versionId: VERSION,
      renderedAt: expect.any(Date),
    });
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('deletes the thumbnail of the version it replaced', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: OLD_KEY });
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('rendered');
    expect(h.storage.delete).toHaveBeenCalledWith(OLD_KEY);
  });

  it("never deletes a replaced key that is not this artifact's thumbnail", async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: 'user/owner1/my-slug/index.html' });
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('rendered');
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('discards the upload when the artifact moved on mid-render', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue(null);
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('discarded');
    expect(h.storage.delete).toHaveBeenCalledWith(KEY);
  });

  it.each([
    ['missing', null],
    ['unsupported', bundleArtifact({ source: { kind: 'reply' } })],
    ['unsupported', bundleArtifact({ moderationStatus: 'taken_down' })],
    ['unsupported', bundleArtifact({ storageKeyPrefix: undefined })],
    ['superseded', bundleArtifact({ sha256Index: OLD_VERSION })],
  ])('consumes the job as %s without rendering', async (outcome, artifact) => {
    h.findOne.mockReturnValue(lean(artifact));
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe(outcome);
    expect(h.renderHtmlThumbnail).not.toHaveBeenCalled();
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('treats a stored index.html that no longer matches the version as superseded', async () => {
    h.buildThumbnailDocument.mockResolvedValue(null);
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('superseded');
    expect(h.renderHtmlThumbnail).not.toHaveBeenCalled();
  });

  it('consumes a render timeout instead of retrying it, keeping the previous thumbnail', async () => {
    h.renderHtmlThumbnail.mockRejectedValue(new ThumbnailRenderTimeoutError('too slow'));
    await expect(processPublishThumbnailJob(job, logger)).resolves.toBe('timed-out');
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.recordPublishedArtifactThumbnail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('rethrows a browser launch failure so SQS retries and eventually dead-letters it', async () => {
    h.renderHtmlThumbnail.mockRejectedValue(new Error('Failed to launch the browser process'));
    await expect(processPublishThumbnailJob(job, logger)).rejects.toThrow('Failed to launch');
    expect(h.storage.upload).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  const run = (body: string) => dispatch({ Records: [{ body }] } as never, {} as never, logger as never);

  it('processes a valid message', async () => {
    await run(JSON.stringify(job));
    expect(logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }));
    expect(h.storage.upload).toHaveBeenCalledWith(IMAGE, KEY, expect.anything());
    expect(logger.info).toHaveBeenCalledWith(`[publishThumbnail] pub1 rendered`);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a path-escaping publicId', JSON.stringify({ publicId: '../x', versionId: VERSION })],
    ['a non-sha version', JSON.stringify({ publicId: 'pub1', versionId: 'v2' })],
  ])('skips %s instead of retrying it forever', async (_label, body) => {
    await expect(run(body)).resolves.toBeUndefined();
    expect(h.findOne).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips an event with no records', async () => {
    await expect(dispatch({ Records: [] } as never, {} as never, logger as never)).resolves.toBeUndefined();
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
