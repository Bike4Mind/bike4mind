// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { PublishedArtifact } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  upload: vi.fn<(data: Buffer, key: string) => Promise<string>>(),
  download: vi.fn<(key: string) => Promise<Buffer>>(),
  remove: vi.fn<(key: string) => Promise<void>>(),
  quota: vi.fn<() => Promise<{ ok: true }>>(),
  refund: vi.fn<() => Promise<void>>(),
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ upload: h.upload, download: h.download, delete: h.remove }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  enqueuePublishThumbnail: vi.fn(),
  deletePublishThumbnails: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/services/publish/invalidatePublishCdn', () => ({
  invalidatePublishCdn: vi.fn(),
  toCacheTarget: (value: unknown) => value,
}));
vi.mock('./organizationPolicy', () => ({ assertPublicationPublicLink: vi.fn() }));
vi.mock('./checkPublishQuota', () => ({ archivedVersionBytes: () => 0, checkPublishQuota: h.quota }));
vi.mock('./publishRateLimit', () => ({ consumePublishAction: async () => ({ refund: h.refund }) }));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ outboundActionGate: () => undefined }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (_gate: unknown, handler: unknown) => handler }),
}));
vi.mock('@server/services/publish', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkScopePermission: async () => ({ ok: true }),
  checkPublishQuota: h.quota,
}));
import finalizeHandler from '../../../pages/api/publish/artifact/finalize';

import { publishStoredArtifact, republishStoredArtifact, unpublishStoredArtifact } from './publishStoredArtifact';

let mongo: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await PublishedArtifact.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  h.objects.clear();
  await PublishedArtifact.deleteMany({});
  h.quota.mockResolvedValue({ ok: true });
  h.refund.mockResolvedValue(undefined);
  h.upload.mockImplementation(async (data, key) => {
    h.objects.set(key, Buffer.from(data));
    return key;
  });
  h.download.mockImplementation(async key => {
    const data = h.objects.get(key);
    if (!data) throw new Error('Object not found');
    return Buffer.from(data);
  });
  h.remove.mockImplementation(async key => {
    h.objects.delete(key);
  });
});

const user = { id: 'owner-1', isAdmin: false, createdAt: new Date('2025-01-01') };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const input = (id: string, content: string) => ({
  user,
  logger,
  content,
  slug: 'same-page',
  visibility: 'public' as const,
  artifact: { id, type: 'code' as const, title: 'Page', version: 1 },
});

function holdUpload(marker: string) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.upload.mockImplementation(async (data, key) => {
    if (data.includes(marker)) {
      reached.resolve();
      await release.promise;
    }
    h.objects.set(key, Buffer.from(data));
    return key;
  });
  return { reached: reached.promise, release: release.resolve };
}

async function currentPage() {
  const page = await PublishedArtifact.findOne({ ownerId: user.id, slug: 'same-page', deletedAt: null }).select(
    '+accessGate.passphraseHash'
  );
  if (!page) throw new Error('Expected a current publication');
  const key = `${page.storageKeyPrefix}${page.indexObjectPath ?? 'index.html'}`;
  return { page, key, bytes: h.objects.get(key) };
}

describe('stored publication identity and immutable live bytes', () => {
  it('allows exactly one same-slug first publish without changing the winner gate or bytes', async () => {
    const bothChecked = Promise.withResolvers<void>();
    let arrivals = 0;
    h.quota.mockImplementation(async () => {
      if (++arrivals === 2) bothChecked.resolve();
      await bothChecked.promise;
      return { ok: true };
    });
    const loserUpload = holdUpload('LOSER_BODY');
    const winner = publishStoredArtifact({
      ...input('artifact-a', 'WINNER_BODY'),
      accessGate: { kind: 'passphrase', passphrase: 'sample-passphrase' },
    });
    const loser = publishStoredArtifact(input('artifact-b', 'LOSER_BODY'));
    try {
      const published = await winner;
      await loserUpload.reached;
      const before = await currentPage();
      loserUpload.release();
      await expect(loser).rejects.toMatchObject({ statusCode: 409 });
      const after = await currentPage();
      expect(after.page.publicId).toBe(published.publicId);
      expect(after.page.source.artifactId).toBe('artifact-a');
      expect(after.page.accessGate?.kind).toBe('passphrase');
      expect(after.page.accessGate?.passphraseHash).toBe(before.page.accessGate?.passphraseHash);
      expect(after.bytes).toEqual(before.bytes);
      expect(after.bytes?.toString()).toContain('WINNER_BODY');
      expect([...h.objects.values()].some(bytes => bytes.includes('LOSER_BODY'))).toBe(false);
      expect(await PublishedArtifact.countDocuments({ deletedAt: null })).toBe(1);
    } finally {
      loserUpload.release();
      await Promise.allSettled([winner, loser]);
    }
  });

  it('cannot republish an old generation over a new publication that reuses its slug', async () => {
    await publishStoredArtifact(input('artifact-a', 'ORIGINAL_BODY'));
    const replacementUpload = holdUpload('STALE_BODY');
    const stale = republishStoredArtifact(input('artifact-a', 'STALE_BODY'));
    try {
      await replacementUpload.reached;
      await unpublishStoredArtifact({ user, logger, artifactId: 'artifact-a' });
      const successor = await publishStoredArtifact(input('artifact-b', 'SUCCESSOR_BODY'));
      const before = await currentPage();
      replacementUpload.release();
      await expect(stale).rejects.toHaveProperty('statusCode');
      const after = await currentPage();
      expect(after.page.publicId).toBe(successor.publicId);
      expect(after.page.source.artifactId).toBe('artifact-b');
      expect(after.bytes).toEqual(before.bytes);
      expect(after.bytes?.toString()).toContain('SUCCESSOR_BODY');
    } finally {
      replacementUpload.release();
      await Promise.allSettled([stale]);
    }
  });
});

describe('API and web publication interleaving', () => {
  it.each(['api', 'web'] as const)(
    'preserves the %s winner when a first web publish and API publish share a slug',
    async winnerKind => {
      const draftId = '11111111-1111-4111-8111-111111111111';
      const html = '<!doctype html><html><head></head><body>WEB_BODY</body></html>';
      h.objects.set(
        `drafts/${draftId}/_manifest.json`,
        Buffer.from(
          JSON.stringify({
            draftId,
            createdAt: new Date().toISOString(),
            createdBy: user.id,
            tier: 'user',
            scopeId: user.id,
            slug: 'same-page',
            title: 'Web page',
            visibility: 'public',
            source: { kind: 'bundle', artifactId: 'web-artifact', artifactType: 'code' },
            files: [{ path: 'index.html', size: Buffer.byteLength(html), mimeType: 'text/html' }],
          })
        )
      );
      h.objects.set(`drafts/${draftId}/index.html`, Buffer.from(html));
      const bothChecked = Promise.withResolvers<void>();
      let checked = 0;
      h.quota.mockImplementation(async () => {
        if (++checked === 2) bothChecked.resolve();
        await bothChecked.promise;
        return { ok: true };
      });
      const held = holdUpload(winnerKind === 'api' ? 'WEB_BODY' : 'API_BODY');
      const { req, res } = createMocks({ method: 'POST', body: { draftId } });
      Object.assign(req, { user, logger });
      const web = (finalizeHandler as unknown as (request: unknown, response: unknown) => Promise<unknown>)(req, res);
      const api = publishStoredArtifact({
        ...input('api-artifact', 'API_BODY'),
        accessGate: { kind: 'passphrase', passphrase: 'sample-passphrase' },
      });
      try {
        await held.reached;
        if (winnerKind === 'api') await api;
        else await web;
        const before = await currentPage();
        held.release();
        if (winnerKind === 'api') {
          await web;
          expect(res._getStatusCode()).toBe(409);
        } else {
          expect(res._getStatusCode()).toBe(200);
          await expect(api).rejects.toMatchObject({ statusCode: 409 });
        }
        const after = await currentPage();
        expect(after.page.publicId).toBe(before.page.publicId);
        expect(after.page.source.artifactId).toBe(before.page.source.artifactId);
        expect(after.page.accessGate?.passphraseHash).toBe(before.page.accessGate?.passphraseHash);
        expect(after.bytes).toEqual(before.bytes);
        expect(after.bytes?.toString()).toContain(winnerKind === 'api' ? 'API_BODY' : 'WEB_BODY');
        expect(await PublishedArtifact.countDocuments({ deletedAt: null })).toBe(1);
      } finally {
        held.release();
        await Promise.allSettled([api, web]);
      }
    }
  );

  it('rejects a stale republish after another republish commits', async () => {
    await publishStoredArtifact(input('artifact-a', 'ORIGINAL_BODY'));
    const held = holdUpload('STALE_BODY');
    const stale = republishStoredArtifact(input('artifact-a', 'STALE_BODY'));
    try {
      await held.reached;
      await republishStoredArtifact(input('artifact-a', 'CURRENT_BODY'));
      const before = await currentPage();
      held.release();
      await expect(stale).rejects.toMatchObject({ statusCode: 409 });
      const after = await currentPage();
      expect(after.bytes).toEqual(before.bytes);
      expect(after.bytes?.toString()).toContain('CURRENT_BODY');
    } finally {
      held.release();
      await Promise.allSettled([stale]);
    }
  });
});

it('retires confirmed prior payloads so identical republishes do not accumulate uncounted copies', async () => {
  await publishStoredArtifact(input('artifact-a', 'UNCHANGED_BODY'));
  const first = await currentPage();
  await republishStoredArtifact(input('artifact-a', 'UNCHANGED_BODY'));
  await republishStoredArtifact(input('artifact-a', 'UNCHANGED_BODY'));
  const current = await currentPage();
  expect(current.key).not.toBe(first.key);
  expect(h.objects.has(first.key)).toBe(false);
  const revisionKeys = [...h.objects.keys()].filter(key => key.includes('/revisions/'));
  expect(revisionKeys).toEqual([current.key]);
  expect(current.bytes?.toString()).toContain('UNCHANGED_BODY');
  expect(current.page.versions).toHaveLength(1);
});

describe('one live v1 page per artifact', () => {
  it('lets exactly one of two concurrent publishes with different slugs create a page', async () => {
    const bothChecked = Promise.withResolvers<void>();
    let arrivals = 0;
    h.quota.mockImplementation(async () => {
      if (++arrivals === 2) bothChecked.resolve();
      await bothChecked.promise;
      return { ok: true };
    });
    const results = await Promise.allSettled([
      publishStoredArtifact({ ...input('artifact-a', 'FIRST_BODY'), slug: 'first-page' }),
      publishStoredArtifact({ ...input('artifact-a', 'SECOND_BODY'), slug: 'second-page' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(loser?.reason).toMatchObject({ statusCode: 409 });
    expect(await PublishedArtifact.countDocuments({ 'source.artifactId': 'artifact-a', deletedAt: null })).toBe(1);
  });

  it('frees the artifact for a new page once its page is unpublished', async () => {
    await publishStoredArtifact({ ...input('artifact-a', 'FIRST_BODY'), slug: 'first-page' });
    await unpublishStoredArtifact({ user, logger, artifactId: 'artifact-a' });
    await publishStoredArtifact({ ...input('artifact-a', 'SECOND_BODY'), slug: 'second-page' });
    expect(await PublishedArtifact.countDocuments({ 'source.artifactId': 'artifact-a', deletedAt: null })).toBe(1);
  });

  it('keeps the marker through a republish', async () => {
    await publishStoredArtifact(input('artifact-a', 'FIRST_BODY'));
    await republishStoredArtifact(input('artifact-a', 'SECOND_BODY'));
    const { page } = await currentPage();
    expect(page.v1ArtifactId).toBe('artifact-a');
  });

  it('does not mark an unmarked page when it is republished', async () => {
    await publishStoredArtifact(input('artifact-a', 'FIRST_BODY'));
    await PublishedArtifact.updateOne({ slug: 'same-page' }, { $unset: { v1ArtifactId: 1 } });
    await republishStoredArtifact(input('artifact-a', 'SECOND_BODY'));
    const raw = await PublishedArtifact.collection.findOne({ slug: 'same-page' });
    expect(raw).not.toHaveProperty('v1ArtifactId');
  });

  it('releases the artifact when a web publish replaces its page with a different artifact', async () => {
    await publishStoredArtifact(input('artifact-a', 'API_BODY'));
    const draftId = '22222222-2222-4222-8222-222222222222';
    const html = '<!doctype html><html><head></head><body>WEB_BODY</body></html>';
    h.objects.set(
      `drafts/${draftId}/_manifest.json`,
      Buffer.from(
        JSON.stringify({
          draftId,
          createdAt: new Date().toISOString(),
          createdBy: user.id,
          tier: 'user',
          scopeId: user.id,
          slug: 'same-page',
          title: 'Web page',
          visibility: 'public',
          source: { kind: 'bundle', artifactId: 'web-artifact', artifactType: 'code' },
          files: [{ path: 'index.html', size: Buffer.byteLength(html), mimeType: 'text/html' }],
        })
      )
    );
    h.objects.set(`drafts/${draftId}/index.html`, Buffer.from(html));
    const { req, res } = createMocks({ method: 'POST', body: { draftId } });
    Object.assign(req, { user, logger });
    await (finalizeHandler as unknown as (request: unknown, response: unknown) => Promise<unknown>)(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(await PublishedArtifact.collection.findOne({ slug: 'same-page' })).not.toHaveProperty('v1ArtifactId');
    await publishStoredArtifact({ ...input('artifact-a', 'AGAIN_BODY'), slug: 'other-page' });
    expect(await PublishedArtifact.countDocuments({ 'source.artifactId': 'artifact-a', deletedAt: null })).toBe(1);
  });

  it('does not constrain pages the web flow publishes, which may share an artifact across slugs', async () => {
    const webPage = (publicId: string, slug: string) => ({
      publicId,
      tier: 'user',
      scopeId: user.id,
      slug,
      ownerId: user.id,
      deletedAt: null,
      source: { kind: 'bundle', artifactId: 'artifact-a' },
    });
    await PublishedArtifact.collection.insertMany([webPage('web-page-1', 'web-one'), webPage('web-page-2', 'web-two')]);
    expect(await PublishedArtifact.countDocuments({ 'source.artifactId': 'artifact-a', deletedAt: null })).toBe(2);
  });
});
