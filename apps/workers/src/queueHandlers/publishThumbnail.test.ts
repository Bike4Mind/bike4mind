import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  recordPublishedArtifactThumbnail: vi.fn(),
  storage: { download: vi.fn(), upload: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn() },
  buildThumbnailDocument: vi.fn(),
  lambdaSend: vi.fn(),
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
// The renderer function itself: the orchestrator reaches it only through a synchronous invoke.
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = h.lambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import {
  describeDroppedAssets,
  dispatch,
  processPublishThumbnailJob,
  THUMBNAIL_STAGING_PREFIX,
} from './publishThumbnail';
import { ThumbnailRendererError } from '@workers/media/invokeThumbnailRenderer';
import { MAX_THUMBNAIL_DOCUMENT_BYTES, MAX_THUMBNAIL_IMAGE_BYTES } from '@workers/media/thumbnailRendererContract';

const VERSION = 'b'.repeat(64);
const OLD_VERSION = 'c'.repeat(64);
const KEY = expect.stringMatching(new RegExp(`^publish-thumbnails/pub1/${VERSION}-[0-9a-f-]{36}[.]webp$`));
const OLD_KEY = `publish-thumbnails/pub1/${OLD_VERSION}.webp`;
const SIGNED_DOCUMENT_URL = 'https://bucket.example.test/drafts/thumbnail-renders/doc.html?X-Amz-Signature=abc';
const SCRIPT_URL = 'https://app.example.test/static/lib/chart.js';
const job = { publicId: 'pub1', versionId: VERSION };

let IMAGE: Buffer;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
const render = vi.fn();

const lean = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
const bundleArtifact = (over: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  source: { kind: 'bundle' },
  storageKeyPrefix: 'user/owner1/my-slug/',
  sha256Index: VERSION,
  manifest: [{ path: 'index.html', mimeType: 'text/html' }],
  ...over,
});
const rendered = (image: Buffer) => ({ status: 'rendered' as const, imageBase64: image.toString('base64') });
const stagingKey = () => h.storage.upload.mock.calls.find(([, key]) => key.startsWith(THUMBNAIL_STAGING_PREFIX))?.[1];
const thumbnailUploads = () => h.storage.upload.mock.calls.filter(([, key]) => key.startsWith('publish-thumbnails/'));

beforeEach(async () => {
  vi.clearAllMocks();
  IMAGE ??= await sharp({ create: { width: 8, height: 5, channels: 3, background: '#3366cc' } })
    .webp()
    .toBuffer();
  h.findOne.mockReturnValue(lean(bundleArtifact()));
  h.buildThumbnailDocument.mockResolvedValue({
    srcdoc: '<h1>x</h1>',
    allowedScriptUrls: [SCRIPT_URL],
    droppedAssets: { missing: [], oversized: [], failed: [] },
  });
  h.storage.upload.mockResolvedValue(undefined);
  h.storage.delete.mockResolvedValue(undefined);
  h.storage.download.mockResolvedValue(Buffer.from('<h1>x</h1>'));
  h.storage.getSignedUrl.mockResolvedValue(SIGNED_DOCUMENT_URL);
  h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: null });
  render.mockResolvedValue(rendered(IMAGE));
});

describe('processPublishThumbnailJob', () => {
  it('stages the document, has the renderer fetch it by presigned link, then stores and records the image', async () => {
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');

    expect(h.findOne).toHaveBeenCalledWith({ publicId: 'pub1', deletedAt: null });
    const docInput = h.buildThumbnailDocument.mock.calls[0][0];
    expect(docInput.versionId).toBe(VERSION);
    await docInput.load('style.css');
    expect(h.storage.download).toHaveBeenCalledWith('user/owner1/my-slug/style.css');

    const staged = stagingKey();
    expect(staged).toMatch(/^drafts\/thumbnail-renders\/[0-9a-f-]{36}\.html$/);
    expect(h.storage.upload).toHaveBeenCalledWith(Buffer.from('<h1>x</h1>'), staged, {
      ContentType: 'text/html; charset=utf-8',
    });
    expect(h.storage.getSignedUrl).toHaveBeenCalledWith(staged, 'get', { expiresIn: 300 });
    expect(render).toHaveBeenCalledWith({ documentUrl: SIGNED_DOCUMENT_URL, allowedScriptUrls: [SCRIPT_URL] });
    expect(h.storage.delete).toHaveBeenCalledWith(staged);

    expect(h.storage.upload).toHaveBeenCalledWith(IMAGE, KEY, {
      ContentType: 'image/webp',
      CacheControl: 'private, max-age=31536000, immutable',
    });
    expect(h.recordPublishedArtifactThumbnail).toHaveBeenCalledWith('pub1', {
      key: KEY,
      versionId: VERSION,
      renderedAt: expect.any(Date),
    });
    expect(h.storage.delete).toHaveBeenCalledTimes(1);
  });

  it('deletes the staged document and rethrows when the renderer fails, so SQS retries', async () => {
    render.mockRejectedValue(new ThumbnailRendererError('thumbnail renderer failed (Unhandled): browser launch'));
    await expect(processPublishThumbnailJob(job, logger, render)).rejects.toThrow('browser launch');
    expect(h.storage.delete).toHaveBeenCalledWith(stagingKey());
    expect(thumbnailUploads()).toHaveLength(0);
    expect(h.recordPublishedArtifactThumbnail).not.toHaveBeenCalled();
  });

  it('still uses the image when deleting the staged document fails, and logs it', async () => {
    h.storage.delete.mockRejectedValueOnce(new Error('SlowDown'));
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SlowDown'));
    expect(thumbnailUploads()).toHaveLength(1);
  });

  it('consumes a render timeout instead of retrying it, keeping the previous thumbnail', async () => {
    render.mockResolvedValue({ status: 'timed-out' });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('timed-out');
    expect(thumbnailUploads()).toHaveLength(0);
    expect(h.recordPublishedArtifactThumbnail).not.toHaveBeenCalled();
    expect(h.storage.delete).toHaveBeenCalledWith(stagingKey());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it.each([
    ['bytes that are not a WebP', () => Buffer.from('<svg onload="x"></svg>')],
    ['an empty image', () => Buffer.alloc(0)],
    [
      'an image over the size limit',
      () => Buffer.concat([IMAGE.subarray(0, 12), Buffer.alloc(MAX_THUMBNAIL_IMAGE_BYTES)]),
    ],
  ])('refuses to store %s from the renderer', async (_label, bytes) => {
    render.mockResolvedValue(rendered(bytes()));
    await expect(processPublishThumbnailJob(job, logger, render)).rejects.toBeInstanceOf(ThumbnailRendererError);
    expect(thumbnailUploads()).toHaveLength(0);
    expect(h.recordPublishedArtifactThumbnail).not.toHaveBeenCalled();
  });

  it('does not stage or render a document over the renderer limit', async () => {
    h.buildThumbnailDocument.mockResolvedValue({
      srcdoc: 'x'.repeat(MAX_THUMBNAIL_DOCUMENT_BYTES + 1),
      allowedScriptUrls: [],
      droppedAssets: { missing: [], oversized: [], failed: [] },
    });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('too-large');
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('deletes the thumbnail of the version it replaced', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: OLD_KEY });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');
    expect(h.storage.delete).toHaveBeenCalledWith(OLD_KEY);
  });

  it.each([
    ['rendered', { replacedKey: OLD_KEY }],
    ['discarded', null],
  ])('logs failed thumbnail cleanup without retrying a %s render', async (outcome, recorded) => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue(recorded);
    h.storage.delete.mockImplementation(async (key: string) => {
      if (key.startsWith('publish-thumbnails/')) throw new Error('AccessDenied');
    });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe(outcome);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
  });

  it("never deletes a replaced key that is not this artifact's thumbnail", async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: 'user/owner1/my-slug/index.html' });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');
    expect(h.storage.delete).not.toHaveBeenCalledWith('user/owner1/my-slug/index.html');
  });

  it('discards the upload when the artifact moved on mid-render', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue(null);
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('discarded');
    expect(h.storage.delete).toHaveBeenCalledWith(KEY);
  });

  it('never deletes a newer render when a same-version job is discarded', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValueOnce(null).mockResolvedValueOnce({ replacedKey: null });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('discarded');
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');

    const [discardedUpload, currentUpload] = thumbnailUploads();
    expect(discardedUpload[1]).not.toBe(currentUpload[1]);
    expect(h.storage.delete).toHaveBeenCalledWith(discardedUpload[1]);
    expect(h.storage.delete).not.toHaveBeenCalledWith(currentUpload[1]);
  });

  it('never deletes a restored version when delayed replacement cleanup finishes', async () => {
    let finishReplacement: (() => void) | undefined;
    let cleanupStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      cleanupStarted = resolve;
    });
    h.storage.delete.mockImplementation(async (key: string) => {
      if (key === OLD_KEY) {
        cleanupStarted?.();
        await new Promise<void>(resolve => {
          finishReplacement = resolve;
        });
      }
    });
    h.recordPublishedArtifactThumbnail.mockResolvedValueOnce({ replacedKey: OLD_KEY });
    const replacing = processPublishThumbnailJob(job, logger, render);
    await started;

    h.findOne.mockReturnValue(lean(bundleArtifact({ sha256Index: OLD_VERSION })));
    await expect(processPublishThumbnailJob({ ...job, versionId: OLD_VERSION }, logger, render)).resolves.toBe(
      'rendered'
    );
    const restoredKey = h.recordPublishedArtifactThumbnail.mock.calls[1][1].key;
    finishReplacement?.();
    await replacing;
    expect(restoredKey).not.toBe(OLD_KEY);
    expect(h.storage.delete).not.toHaveBeenCalledWith(restoredKey);
  });

  it.each([
    ['missing', null],
    ['unsupported', bundleArtifact({ source: { kind: 'reply' } })],
    ['unsupported', bundleArtifact({ moderationStatus: 'taken_down' })],
    ['unsupported', bundleArtifact({ storageKeyPrefix: undefined })],
    ['superseded', bundleArtifact({ sha256Index: OLD_VERSION })],
  ])('consumes the job as %s without rendering', async (outcome, artifact) => {
    h.findOne.mockReturnValue(lean(artifact));
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe(outcome);
    expect(render).not.toHaveBeenCalled();
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('treats a stored index.html that no longer matches the version as superseded', async () => {
    h.buildThumbnailDocument.mockResolvedValue(null);
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('superseded');
    expect(render).not.toHaveBeenCalled();
  });

  it('logs the assets it renders without, by reason, and still renders', async () => {
    h.buildThumbnailDocument.mockResolvedValue({
      srcdoc: '<h1>x</h1>',
      allowedScriptUrls: [],
      droppedAssets: { missing: ['a.png', 'b.css'], oversized: [], failed: ['c.png'] },
    });
    render.mockResolvedValue(rendered(IMAGE));
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');
    expect(logger.info).toHaveBeenCalledWith(
      '[publishThumbnail] pub1 rendering without 3 asset(s): missing 2 ["a.png","b.css"], failed 1 ["c.png"]'
    );
  });
});

describe('describeDroppedAssets', () => {
  it('is undefined when nothing was dropped', () => {
    expect(describeDroppedAssets({ missing: [], oversized: [], failed: [] })).toBeUndefined();
  });

  it('caps the listed paths per reason but counts all of them, and keeps the line single', () => {
    const missing = ['1', '2', '3', '4', '5', '6'].map(n => `img/${n}.png`);
    const line = describeDroppedAssets({ missing, oversized: ['big\nfile.png'], failed: [] });
    expect(line).toBe(
      '7 asset(s): missing 6 ["img/1.png","img/2.png","img/3.png","img/4.png","img/5.png"], oversized 1 ["big\\nfile.png"]'
    );
  });
});

describe('dispatch (end to end, renderer function mocked at the invoke)', () => {
  const ENV = 'PUBLISH_THUMBNAIL_RENDERER_FUNCTION';
  const run = (body: string) => dispatch({ Records: [{ body }] } as never, {} as never, logger as never);
  const lambdaReturns = (payload: unknown, functionError?: string) =>
    h.lambdaSend.mockResolvedValue({
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
      ...(functionError ? { FunctionError: functionError } : {}),
    });

  beforeEach(() => {
    vi.stubEnv(ENV, 'stage-PublishThumbnailRenderer');
    lambdaReturns(rendered(IMAGE));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('invokes the renderer synchronously with only the staged link and the script allowlist', async () => {
    await run(JSON.stringify(job));

    expect(h.lambdaSend).toHaveBeenCalledTimes(1);
    const [command, options] = h.lambdaSend.mock.calls[0];
    expect(command.input).toMatchObject({
      FunctionName: 'stage-PublishThumbnailRenderer',
      InvocationType: 'RequestResponse',
    });
    expect(JSON.parse(Buffer.from(command.input.Payload).toString('utf-8'))).toEqual({
      documentUrl: SIGNED_DOCUMENT_URL,
      allowedScriptUrls: [SCRIPT_URL],
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }));
    expect(h.storage.upload).toHaveBeenCalledWith(IMAGE, KEY, expect.anything());
    expect(logger.info).toHaveBeenCalledWith('[publishThumbnail] pub1 rendered');
  });

  it('rethrows a renderer Lambda timeout so SQS retries and eventually dead-letters it', async () => {
    lambdaReturns({ errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 75.00 seconds' }, 'Unhandled');
    await expect(run(JSON.stringify(job))).rejects.toThrow('Sandbox.Timedout');
    expect(thumbnailUploads()).toHaveLength(0);
    expect(h.storage.delete).toHaveBeenCalledWith(stagingKey());
  });

  it('rethrows when the invoke itself fails (throttled, aborted)', async () => {
    h.lambdaSend.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException' }));
    await expect(run(JSON.stringify(job))).rejects.toBeInstanceOf(ThumbnailRendererError);
    expect(thumbnailUploads()).toHaveLength(0);
  });

  it('consumes a timed-out answer from the renderer', async () => {
    lambdaReturns({ status: 'timed-out' });
    await expect(run(JSON.stringify(job))).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('[publishThumbnail] pub1 timed-out');
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a path-escaping publicId', JSON.stringify({ publicId: '../x', versionId: VERSION })],
    ['a non-sha version', JSON.stringify({ publicId: 'pub1', versionId: 'v2' })],
  ])('skips %s instead of retrying it forever', async (_label, body) => {
    await expect(run(body)).resolves.toBeUndefined();
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.lambdaSend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips an event with no records', async () => {
    await expect(dispatch({ Records: [] } as never, {} as never, logger as never)).resolves.toBeUndefined();
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
