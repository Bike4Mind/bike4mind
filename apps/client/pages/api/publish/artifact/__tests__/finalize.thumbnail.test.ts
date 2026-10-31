import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createHash } from 'node:crypto';
import { createMocks } from 'node-mocks-http';

// Finalize queues an owner-only thumbnail for the version it just promoted, and a queue that is
// down or absent (self-host) must never fail the publish. Uses the REAL enqueuePublishThumbnail
// against a stubbed SQS seam, so the "never throws" contract is exercised end to end.

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload, sendToQueue, getSourceQueueUrl } = vi.hoisted(
  () => ({
    mockFindOne: vi.fn(),
    mockFindOneAndUpdate: vi.fn(),
    mockDownload: vi.fn(),
    mockUpload: vi.fn(() => Promise.resolve()),
    sendToQueue: vi.fn(),
    getSourceQueueUrl: vi.fn(),
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@bike4mind/server-utils/utils/sqs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendToQueue: (...a: unknown[]) => sendToQueue(...a),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSourceQueueUrl: (...a: unknown[]) => getSourceQueueUrl(...a),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(mockFindOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(mockFindOneAndUpdate(...a)),
  },
}));

vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
    buildPublishS3KeyPrefix: () => 'user/owner1/art/',
    buildPublishUrlPath: () => '/p/u/owner1/art',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
  };
});

import handler from '../finalize';

const DRAFT_ID = '44444444-4444-4444-8444-444444444444';
const QUEUE_URL = 'https://sqs.example.test/queue/publish-thumbnail';
const INDEX = '<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Prebuilt</h1></body></html>';

const setDraft = (source: Record<string, unknown>) => {
  const manifest = {
    draftId: DRAFT_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'owner1',
    tier: 'user',
    scopeId: 'owner1',
    slug: 'art',
    title: 'My Artifact',
    visibility: 'private',
    files: [{ path: 'index.html', size: 1, mimeType: 'text/html' }],
    source,
  };
  mockDownload.mockImplementation((key: string) =>
    Promise.resolve(Buffer.from(key.endsWith('_manifest.json') ? JSON.stringify(manifest) : INDEX))
  );
};

const run = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { draftId: DRAFT_ID } });
  const r = req as Record<string, unknown>;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  r.user = { id: 'owner1', isAdmin: false, organizationId: null };
  r.logger = logger;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, logger };
};

const promotedSha = () => {
  const call = mockUpload.mock.calls.find(c => String((c as unknown[])[1]).endsWith('index.html')) as unknown[];
  return createHash('sha256')
    .update(call[0] as Buffer)
    .digest('hex');
};

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null);
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
  sendToQueue.mockReset().mockResolvedValue(undefined);
  getSourceQueueUrl.mockReset().mockReturnValue(QUEUE_URL);
});

describe('finalize - owner-only thumbnail enqueue', () => {
  it('queues a render of the promoted version', async () => {
    setDraft({ kind: 'bundle', artifactId: 'a1' });
    const { res } = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(getSourceQueueUrl).toHaveBeenCalledWith('publishThumbnailQueue');
    expect(sendToQueue).toHaveBeenCalledWith(QUEUE_URL, { publicId: 'pub1', versionId: promotedSha() });
  });

  it('still publishes (200) when the enqueue fails, logging a warning', async () => {
    setDraft({ kind: 'bundle', artifactId: 'a1' });
    sendToQueue.mockRejectedValue(new Error('SQS unavailable'));
    const { res, logger } = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SQS unavailable'));
  });

  it('still publishes (200) where no thumbnail queue is provisioned', async () => {
    setDraft({ kind: 'bundle', artifactId: 'a1' });
    getSourceQueueUrl.mockImplementation(() => {
      throw new Error('queue URL not configured');
    });
    const { res } = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(sendToQueue).not.toHaveBeenCalled();
  });
});
