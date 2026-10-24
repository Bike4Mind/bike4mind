import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  exists: vi.fn(),
  recordPublishedArtifactThumbnail: vi.fn(),
  storage: { download: vi.fn(), upload: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn() },
  buildThumbnailDocument: vi.fn(),
  lambdaSend: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { findOne: h.findOne, exists: h.exists },
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

import { dispatch, processPublishThumbnailJob, THUMBNAIL_STAGING_PREFIX } from './publishThumbnail';
import { ThumbnailRendererError } from '@workers/media/invokeThumbnailRenderer';
import { MAX_THUMBNAIL_DOCUMENT_BYTES, MAX_THUMBNAIL_IMAGE_BYTES } from '@workers/media/thumbnailRendererContract';

const VERSION = 'b'.repeat(64);
const OLD_VERSION = 'c'.repeat(64);
const KEY = `publish-thumbnails/pub1/${VERSION}.webp`;
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
const thumbnailUploads = () => h.storage.upload.mock.calls.filter(([, key]) => key === KEY);

beforeEach(async () => {
  vi.clearAllMocks();
  IMAGE ??= await sharp({ create: { width: 8, height: 5, channels: 3, background: '#3366cc' } })
    .webp()
    .toBuffer();
  h.findOne.mockReturnValue(lean(bundleArtifact()));
  h.exists.mockResolvedValue(null);
  h.buildThumbnailDocument.mockResolvedValue({
    srcdoc: '<h1>x</h1>',
    allowedScriptUrls: [SCRIPT_URL],
    droppedAssets: [],
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
      droppedAssets: [],
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

  it("never deletes a replaced key that is not this artifact's thumbnail", async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue({ replacedKey: 'user/owner1/my-slug/index.html' });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('rendered');
    expect(h.storage.delete).not.toHaveBeenCalledWith('user/owner1/my-slug/index.html');
  });

  it('discards the upload when the artifact moved on mid-render', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue(null);
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('discarded');
    expect(h.exists).toHaveBeenCalledWith({ publicId: 'pub1', deletedAt: null, 'thumbnail.key': KEY });
    expect(h.storage.delete).toHaveBeenCalledWith(KEY);
  });

  it('keeps a discarded upload whose key the record still shows (a late re-render of the shown version)', async () => {
    h.recordPublishedArtifactThumbnail.mockResolvedValue(null);
    h.exists.mockResolvedValue({ _id: 'x' });
    await expect(processPublishThumbnailJob(job, logger, render)).resolves.toBe('discarded');
    expect(h.storage.delete).not.toHaveBeenCalledWith(KEY);
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
