import { createHash } from 'node:crypto';
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  findOne: vi.fn(),
  exists: vi.fn(),
  findOneAndUpdate: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  checkPublishQuota: vi.fn(),
  consumePublishAction: vi.fn(),
  refund: vi.fn(),
  assertPublicationPublicLink: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  enqueuePublishThumbnail: vi.fn(),
  deletePublishThumbnails: vi.fn(),
  softDelete: vi.fn(),
  buildReactArtifactBundle: vi.fn(),
}));

/** A query that resolves when awaited and also supports the `.select().lean()` chain. */
const query = (value: unknown) => ({
  select: () => ({ lean: () => Promise.resolve(value) }),
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject),
});

vi.mock('@bike4mind/database', () => ({
  liveShareTokens: (page: { shareTokens?: unknown[] }) => page.shareTokens ?? [],
  PublishedArtifact: {
    create: (...a: unknown[]) => m.create(...a),
    findOne: (...a: unknown[]) => m.findOne(...a),
    exists: (...a: unknown[]) => m.exists(...a),
    findOneAndUpdate: (...a: unknown[]) => m.findOneAndUpdate(...a),
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ upload: m.upload, download: m.download, delete: m.remove }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  enqueuePublishThumbnail: (...a: unknown[]) => m.enqueuePublishThumbnail(...a),
  deletePublishThumbnails: (...a: unknown[]) => m.deletePublishThumbnails(...a),
}));
vi.mock('@bike4mind/server-utils/services/publish/invalidatePublishCdn', () => ({
  invalidatePublishCdn: (...a: unknown[]) => m.invalidatePublishCdn(...a),
  toCacheTarget: (doc: unknown) => doc,
}));
vi.mock('./organizationPolicy', () => ({
  assertPublicationPublicLink: (...a: unknown[]) => m.assertPublicationPublicLink(...a),
}));
vi.mock('./checkPublishQuota', () => ({
  archivedVersionBytes: () => 0,
  checkPublishQuota: (...a: unknown[]) => m.checkPublishQuota(...a),
}));
vi.mock('./publishRateLimit', () => ({
  consumePublishAction: (...a: unknown[]) => m.consumePublishAction(...a),
}));
vi.mock('./transpileReactArtifact', () => ({
  buildReactArtifactBundle: (...a: unknown[]) => m.buildReactArtifactBundle(...a),
  ReactArtifactTranspileError: class ReactArtifactTranspileError extends Error {},
  UnsupportedReactDependencyError: class UnsupportedReactDependencyError extends Error {},
}));

import {
  absolutePublishUrl,
  publishStoredArtifact,
  republishStoredArtifact,
  unpublishStoredArtifact,
} from './publishStoredArtifact';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const user = { id: 'user-1', isAdmin: false, createdAt: new Date('2025-01-01') };
const artifact = { id: 'art-1', type: 'code' as const, title: 'Signup flow', version: 3 };

const oldSha = createHash('sha256').update('old').digest('hex');
const previousPage = {
  publicId: 'abc123def456',
  slug: 'signup-flow',
  publishedAt: new Date('2026-10-01'),
  ownerId: 'user-1',
  visibility: 'public',
  size: { totalBytes: 10, fileCount: 1 },
  sha256Index: oldSha,
  versions: [{ sha256Index: oldSha, indexBytes: 10 }],
};

function savedDoc(overrides: Record<string, unknown> = {}) {
  return { publicId: 'abc123def456', visibility: 'public', accessGate: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://app.example.com/';
  m.findOne.mockReturnValue(query(null));
  m.exists.mockResolvedValue(null);
  m.checkPublishQuota.mockResolvedValue({ ok: true });
  m.consumePublishAction.mockResolvedValue({ refund: m.refund });
  m.assertPublicationPublicLink.mockResolvedValue(undefined);
  m.upload.mockResolvedValue(undefined);
  m.remove.mockResolvedValue(undefined);
  m.refund.mockResolvedValue(undefined);
  m.create.mockImplementation(() => Promise.resolve(savedDoc()));
  m.download.mockResolvedValue(Buffer.from('old'));
  m.findOneAndUpdate.mockImplementation(() => Promise.resolve(savedDoc()));
  m.invalidatePublishCdn.mockResolvedValue(undefined);
  m.enqueuePublishThumbnail.mockResolvedValue(undefined);
});

describe('absolutePublishUrl', () => {
  it('joins the app origin and the path without doubling the slash', () => {
    expect(absolutePublishUrl('/p/u/user-1/signup-flow')).toBe('https://app.example.com/p/u/user-1/signup-flow');
  });
});

describe('publishStoredArtifact', () => {
  const base = { user, artifact, content: 'graph TD; A-->B', logger, slug: 'signup-flow' } as const;

  it('inserts on a first publish', async () => {
    await publishStoredArtifact({ ...base, visibility: 'public' });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0]).toMatchObject({ tier: 'user', scopeId: user.id, slug: base.slug });
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('marks the new page with the artifact id that its unique index keys on', async () => {
    await publishStoredArtifact({ ...base, visibility: 'public' });
    expect(m.create.mock.calls[0][0]).toMatchObject({ v1ArtifactId: artifact.id });
  });

  it('writes the access gate in the same record write as the visibility', async () => {
    const page = await publishStoredArtifact({
      ...base,
      visibility: 'public',
      accessGate: { kind: 'passphrase', passphrase: 'correct-horse' },
    });

    expect(m.create).toHaveBeenCalledTimes(1);
    const update = m.create.mock.calls[0][0];
    expect(update.visibility).toBe('public');
    expect(update.accessGate.kind).toBe('passphrase');
    expect(update.accessGate.passphraseHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(update)).not.toContain('correct-horse');
    expect(update.source).toEqual({ kind: 'bundle', artifactId: 'art-1', artifactType: 'code' });
    expect(page).toMatchObject({ slug: 'signup-flow', path: '/p/u/user-1/signup-flow', publishedVersion: 3 });
  });

  it('refuses a gate on a page that is not public, before anything is written', async () => {
    await expect(
      publishStoredArtifact({
        ...base,
        visibility: 'private',
        accessGate: { kind: 'passphrase', passphrase: 'correct-horse' },
      })
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
    expect(m.consumePublishAction).not.toHaveBeenCalled();
  });

  it('rejects a domain that is a public suffix', async () => {
    await expect(
      publishStoredArtifact({
        ...base,
        visibility: 'public',
        accessGate: { kind: 'domain', allowed_domains: ['co.uk'] },
      })
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a reserved slug', async () => {
    await expect(publishStoredArtifact({ ...base, slug: 'admin', visibility: 'public' })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('generates a valid slug from the title when none is sent', async () => {
    const { slug: _omit, ...withoutSlug } = base;
    const page = await publishStoredArtifact({ ...withoutSlug, visibility: 'public' });
    expect(page.slug).toMatch(/^signup-flow-[0-9a-f]{6}$/);
  });

  it('answers 409 when the artifact already has a page, and writes nothing', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    await expect(publishStoredArtifact({ ...base, visibility: 'public' })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.consumePublishAction).not.toHaveBeenCalled();
  });

  it('answers 409 when the slug belongs to another of the caller pages', async () => {
    m.exists.mockResolvedValue({ _id: 'other' });
    await expect(publishStoredArtifact({ ...base, visibility: 'public' })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('answers 400 storage_limit_exceeded without spending the daily allowance', async () => {
    m.checkPublishQuota.mockResolvedValue({ ok: false, status: 413, code: 'quota_bytes_exceeded', error: 'full' });
    await expect(publishStoredArtifact({ ...base, visibility: 'public' })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { errorCode: 'storage_limit_exceeded' },
    });
    expect(m.consumePublishAction).not.toHaveBeenCalled();
  });

  it('hands the daily allowance back when the write fails after it was counted', async () => {
    m.upload.mockRejectedValue(new Error('s3 down'));
    await expect(publishStoredArtifact({ ...base, visibility: 'public' })).rejects.toThrow('s3 down');
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it('answers 409 when another request took the slug between the check and the write', async () => {
    m.create.mockImplementation(() => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })));
    await expect(publishStoredArtifact({ ...base, visibility: 'public' })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it('purges the CDN for a public page', async () => {
    await publishStoredArtifact({ ...base, visibility: 'public' });
    expect(m.invalidatePublishCdn).toHaveBeenCalledTimes(1);
  });
});

describe('publishStoredArtifact generated slug', () => {
  const noSlug = { user, artifact, content: 'graph TD; A-->B', logger, visibility: 'public' } as const;

  it('derives the slug from the title and the artifact id, so it is stable across calls', async () => {
    await publishStoredArtifact(noSlug);
    await publishStoredArtifact(noSlug);
    const slugs = m.create.mock.calls.map(c => c[0].slug);
    expect(slugs[0]).toMatch(/^signup-flow-[0-9a-f]{6}$/);
    expect(slugs[1]).toBe(slugs[0]);
  });

  it('gives different artifacts with the same title different slugs', async () => {
    await publishStoredArtifact(noSlug);
    await publishStoredArtifact({ ...noSlug, artifact: { ...artifact, id: 'art-2' } });
    const slugs = m.create.mock.calls.map(c => c[0].slug);
    expect(slugs[1]).not.toBe(slugs[0]);
  });

  it('answers 409 for the loser of two concurrent slugless publishes of one artifact', async () => {
    m.create.mockImplementation(() => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })));
    await expect(publishStoredArtifact(noSlug)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('republishStoredArtifact', () => {
  const base = { user, artifact, content: 'graph TD; A-->B; B-->C', logger } as const;

  it('answers 404 when the artifact has no page', async () => {
    await expect(republishStoredArtifact(base)).rejects.toMatchObject({ statusCode: 404 });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('keeps the slug and leaves visibility and the gate out of the write', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    const page = await republishStoredArtifact(base);

    const filter = m.findOneAndUpdate.mock.calls[0][0];
    expect(filter.slug).toBe('signup-flow');
    const set = m.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set).not.toHaveProperty('visibility');
    expect(set).not.toHaveProperty('accessGate');
    expect(set).not.toHaveProperty('v1ArtifactId');
    expect(set.previousVersionMeta.sha256Index).toBe(oldSha);
    expect(page.slug).toBe('signup-flow');
  });

  it('runs the public-link policy check for a public page', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    await republishStoredArtifact(base);
    expect(m.assertPublicationPublicLink).toHaveBeenCalledTimes(1);
  });

  it('runs the public-link policy check for a private page with a live share link', async () => {
    m.findOne.mockReturnValue(query({ ...previousPage, visibility: 'private', shareTokens: [{ tokenHash: 'h' }] }));
    await republishStoredArtifact(base);
    expect(m.assertPublicationPublicLink).toHaveBeenCalledTimes(1);
  });

  it('skips the policy check for a private page with no share link', async () => {
    m.findOne.mockReturnValue(query({ ...previousPage, visibility: 'private' }));
    await republishStoredArtifact(base);
    expect(m.assertPublicationPublicLink).not.toHaveBeenCalled();
  });

  it('never inserts: a page changed since lookup answers 409 instead of being recreated', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    m.findOneAndUpdate.mockImplementation(() => Promise.resolve(null));
    await expect(republishStoredArtifact(base)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ upsert: false });
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it('archives the replaced index.html before overwriting it', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    await republishStoredArtifact(base);
    const keys = m.upload.mock.calls.map(c => c[1]);
    expect(keys[0]).toBe(`user/user-1/signup-flow/versions/${oldSha}.html`);
    expect(keys[1]).toMatch(/^user\/user-1\/signup-flow\/revisions\/[0-9a-f-]{36}\/index\.html$/);
  });
});

describe('unpublishStoredArtifact', () => {
  it('answers 404 when there is no page', async () => {
    await expect(unpublishStoredArtifact({ user, artifactId: 'art-1', logger })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('soft-deletes the page and purges the cached public copy', async () => {
    m.findOne.mockReturnValue(query({ publicId: 'abc123def456', visibility: 'public', softDelete: m.softDelete }));
    await unpublishStoredArtifact({ user, artifactId: 'art-1', logger });
    expect(m.softDelete).toHaveBeenCalledWith('user-1');
    expect(m.invalidatePublishCdn).toHaveBeenCalledTimes(1);
    expect(m.deletePublishThumbnails).toHaveBeenCalledWith(['abc123def456'], logger);
  });

  it('does not purge the CDN for a page that was never public', async () => {
    m.findOne.mockReturnValue(query({ publicId: 'p1', visibility: 'private', softDelete: m.softDelete }));
    await unpublishStoredArtifact({ user, artifactId: 'art-1', logger });
    expect(m.invalidatePublishCdn).not.toHaveBeenCalled();
  });
});

describe('publication write outcomes', () => {
  const base = {
    user,
    artifact,
    content: 'graph TD; A-->B',
    logger,
    slug: 'signup-flow',
    visibility: 'public',
  } as const;
  it('retains payload and allowance when the database acknowledgement is ambiguous', async () => {
    m.create.mockRejectedValue(new Error('connection lost after write'));
    await expect(publishStoredArtifact(base)).rejects.toThrow('connection lost after write');
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.refund).not.toHaveBeenCalled();
  });
  it('retains a committed payload and allowance if follow-up thumbnail work throws', async () => {
    m.enqueuePublishThumbnail.mockRejectedValueOnce(new Error('unexpected follow-up error'));
    await expect(publishStoredArtifact(base)).rejects.toThrow('unexpected follow-up error');
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.refund).not.toHaveBeenCalled();
  });
  it('does not replace the live pointer if archiving the prior version fails', async () => {
    m.findOne.mockReturnValue(query(previousPage));
    m.upload.mockRejectedValueOnce(new Error('archive unavailable'));
    await expect(republishStoredArtifact(base)).rejects.toThrow('archive unavailable');
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(m.remove).toHaveBeenCalledTimes(1);
  });
});
