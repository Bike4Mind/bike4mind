import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the API client and the share-footer builder so we can drive/inspect the
// 3-step publish flow without a network or DOM. buildShareFooterHtml is irrelevant
// to slug/version logic, so stub it out.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('@client/app/utils/shareFooter', () => ({
  buildShareFooterHtml: () => '<!--footer-->',
}));

import { api } from '@client/app/contexts/ApiContext';
import {
  publishArtifactBundle,
  findPublishedByArtifact,
  artifactBundlePublisher,
  buildArtifactPublishWiring,
} from '../publishApi';

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

const DRAFT = {
  draftId: 'draft-1',
  uploadUrls: [{ path: 'index.html', url: 'https://s3.example/put', expiresAt: 'x' }],
};
const RESULT = {
  publicId: 'pub-1',
  url: '/p/u/u1/chronosphere-abc123',
  tier: 'user',
  scopeId: 'u1',
  slug: 'chronosphere-abc123',
  visibility: 'public',
  publishedAt: '2026-01-01T00:00:00.000Z',
};

/** Wire api.post to resolve the upload-url draft then the finalize result. */
function wirePublishPosts() {
  apiPost.mockImplementation((url: string) => {
    if (url === '/api/publish/artifact/upload-url') return Promise.resolve({ data: DRAFT });
    if (url === '/api/publish/artifact/finalize') return Promise.resolve({ data: RESULT });
    return Promise.resolve({ data: {} });
  });
}

/** The slug sent to upload-url (what finalize upserts on). */
function uploadedSlug(): string {
  const call = apiPost.mock.calls.find(c => c[0] === '/api/publish/artifact/upload-url');
  return (call?.[1] as { slug: string }).slug;
}

/** The `source.artifactId` sent to upload-url (persisted as the publication's linkage). */
function uploadedSourceArtifactId(): string | undefined {
  const call = apiPost.mock.calls.find(c => c[0] === '/api/publish/artifact/upload-url');
  return (call?.[1] as { source?: { artifactId?: string } }).source?.artifactId;
}

beforeEach(() => {
  vi.clearAllMocks();
  // S3 PUT in step 2.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

describe('publishArtifactBundle', () => {
  it('derives the slug from title + artifact id when no slug override is given', async () => {
    wirePublishPosts();
    await publishArtifactBundle({
      artifactId: 'artifact_abcdef123456',
      type: 'react',
      content: 'export default () => null;',
      title: 'Chronosphere',
      userId: 'u1',
    });
    // slugify('Chronosphere') + '-' + first 6 chars of the artifact id
    expect(uploadedSlug()).toBe('chronosphere-artifa');
  });

  it('uses the slug override verbatim (lands a new version on the existing publication)', async () => {
    wirePublishPosts();
    await publishArtifactBundle({
      artifactId: 'artifact_abcdef123456',
      type: 'react',
      content: 'export default () => null;',
      // A drifted title would normally change the derived slug...
      title: 'Chronosphere DELUXE EDITION!!!',
      userId: 'u1',
      slug: 'chronosphere-artifa',
    });
    // ...but the override pins it to the original publication's slug.
    expect(uploadedSlug()).toBe('chronosphere-artifa');
  });

  it('throws on empty content without calling the API', async () => {
    await expect(
      publishArtifactBundle({ artifactId: 'a', type: 'react', content: '   ', title: 'X', userId: 'u1' })
    ).rejects.toThrow(/no content/i);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('appends a discriminator to the derived slug when forceUniqueSlug is set (publish-as-new)', async () => {
    wirePublishPosts();
    await publishArtifactBundle({
      artifactId: 'artifact_abcdef123456',
      type: 'react',
      content: 'export default () => null;',
      title: 'Chronosphere',
      userId: 'u1',
      // Publish-as-new of an already-published artifact -> guarantee a slug distinct from
      // every prior publication (not just the most-recent one).
      forceUniqueSlug: true,
    });
    expect(uploadedSlug()).not.toBe('chronosphere-artifa');
    // Derived slug + '-' + up to 6 base-36 chars, staying within SlugSchema's 64-char cap.
    expect(uploadedSlug()).toMatch(/^chronosphere-artifa-[a-z0-9]{1,6}$/);
    expect(uploadedSlug().length).toBeLessThanOrEqual(64);
  });

  it('ignores forceUniqueSlug when an explicit slug is given (that is the update path)', async () => {
    wirePublishPosts();
    await publishArtifactBundle({
      artifactId: 'artifact_abcdef123456',
      type: 'react',
      content: 'export default () => null;',
      title: 'Chronosphere',
      userId: 'u1',
      slug: 'chronosphere-artifa',
      forceUniqueSlug: true,
    });
    expect(uploadedSlug()).toBe('chronosphere-artifa');
  });

  it('does not discriminate the derived slug without forceUniqueSlug (first-ever publish)', async () => {
    wirePublishPosts();
    await publishArtifactBundle({
      artifactId: 'artifact_abcdef123456',
      type: 'react',
      content: 'export default () => null;',
      title: 'Chronosphere',
      userId: 'u1',
    });
    expect(uploadedSlug()).toBe('chronosphere-artifa');
  });
});

describe('findPublishedByArtifact', () => {
  it('queries by sourceArtifactId and returns the first (most recent) match', async () => {
    const match = { publicId: 'pub-1', slug: 'chronosphere-artifa', title: 'Chronosphere', versionsCount: 2 };
    apiGet.mockResolvedValue({ data: { artifacts: [match, { publicId: 'pub-0' }] } });

    const found = await findPublishedByArtifact('artifact_abcdef123456');

    expect(apiGet).toHaveBeenCalledWith('/api/publish/artifacts?sourceArtifactId=artifact_abcdef123456');
    expect(found).toEqual(match);
  });

  it('returns null when there is no match', async () => {
    apiGet.mockResolvedValue({ data: { artifacts: [] } });
    expect(await findPublishedByArtifact('artifact_x')).toBeNull();
  });

  it('degrades to null on a lookup failure instead of throwing (never blocks publishing)', async () => {
    apiGet.mockRejectedValue(new Error('network down'));
    await expect(findPublishedByArtifact('artifact_x')).resolves.toBeNull();
  });
});

describe('artifactBundlePublisher', () => {
  const baseInput = {
    artifactId: 'artifact_abcdef123456',
    type: 'react',
    content: 'export default () => null;',
    title: 'Chronosphere v2',
    userId: 'u1',
  };

  it('reuses the existing slug in "update" mode (lands a new version)', async () => {
    wirePublishPosts();
    const publish = artifactBundlePublisher(baseInput);

    await publish('public', { mode: 'update', existingSlug: 'chronosphere-artifa' });

    // Update mode pins the upsert to the existing slug -> finalize appends a version,
    // even though the drifted title would otherwise derive 'chronosphere-v2-artifa'.
    expect(uploadedSlug()).toBe('chronosphere-artifa');
  });

  it('in "new" mode with a prior publication, forces a unique (discriminated) slug', async () => {
    wirePublishPosts();
    const publish = artifactBundlePublisher(baseInput);

    await publish('public', { mode: 'new', existingSlug: 'chronosphere-v2-artifa' });

    // Publish-as-new must never reuse the existing slug, or finalize would upsert a version
    // onto it instead of creating a separate page.
    expect(uploadedSlug()).not.toBe('chronosphere-v2-artifa');
    expect(uploadedSlug()).toMatch(/^chronosphere-v2-artifa-[a-z0-9]{1,6}$/);
  });

  it('in "new" mode, never lands on the ORIGINAL slug even after prior forks (multi-publish)', async () => {
    wirePublishPosts();
    const publish = artifactBundlePublisher(baseInput);

    // Reproduces the multi-publish sequence: a prior "publish as new" already created
    // 'chronosphere-v2-artifa-abc12', so the dialog now surfaces THAT as the most-recent
    // existing slug. The derived slug ('chronosphere-v2-artifa') must still be discriminated
    // otherwise it would collide with the ORIGINAL publication and append a version to it.
    await publish('public', { mode: 'new', existingSlug: 'chronosphere-v2-artifa-abc12' });

    expect(uploadedSlug()).not.toBe('chronosphere-v2-artifa');
    expect(uploadedSlug()).not.toBe('chronosphere-v2-artifa-abc12');
    expect(uploadedSlug()).toMatch(/^chronosphere-v2-artifa-[a-z0-9]{1,6}$/);
  });

  it('derives a fresh slug when called with no options (plain share)', async () => {
    wirePublishPosts();
    const publish = artifactBundlePublisher(baseInput);

    await publish('public');

    expect(uploadedSlug()).toBe('chronosphere-v2-artifa');
  });

  it('discriminates publish-as-new slugs even within the SAME millisecond (random tail)', async () => {
    // Freeze the clock so the timestamp component is identical for both publishes - the
    // discriminator must still diverge, proving it does not rely on time alone.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const publish = artifactBundlePublisher(baseInput);

      wirePublishPosts();
      await publish('public', { mode: 'new', existingSlug: 'chronosphere-v2-artifa' });
      const first = uploadedSlug();

      vi.clearAllMocks();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      wirePublishPosts();
      await publish('public', { mode: 'new', existingSlug: 'chronosphere-v2-artifa' });
      const second = uploadedSlug();

      expect(first).not.toBe(second);
      expect(first).toMatch(/^chronosphere-v2-artifa-[a-z0-9]{6}$/);
      expect(second).toMatch(/^chronosphere-v2-artifa-[a-z0-9]{6}$/);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('buildArtifactPublishWiring — id stability', () => {
  // Regression guard for the full-viewer id-drift bug: the update-existing LOOKUP and the
  // PUBLISH must key on the SAME artifact id. Both publish surfaces (the chat artifact card
  // in ArtifactGallery and the full viewer in KnowledgeViewer) route through this one helper,
  // so pinning it here covers both - a drifted id would miss the lookup AND corrupt the
  // persisted source.artifactId.
  it('keys resolveExisting and publish on the SAME id', async () => {
    apiGet.mockResolvedValue({ data: { artifacts: [] } });
    wirePublishPosts();

    const wiring = buildArtifactPublishWiring({
      artifactId: 'artifact_stable_id_123',
      type: 'html',
      content: '<p>hello</p>',
      title: 'Stable',
      userId: 'u1',
    });

    await wiring.resolveExisting();
    await wiring.publish('public');

    // Lookup queried the id...
    expect(apiGet).toHaveBeenCalledWith('/api/publish/artifacts?sourceArtifactId=artifact_stable_id_123');
    // ...and the published bundle persisted the SAME id as its source linkage.
    expect(uploadedSourceArtifactId()).toBe('artifact_stable_id_123');
  });

  it('propagates the resolveExisting lookup result (drives update-vs-new)', async () => {
    const existing = { publicId: 'pub-1', slug: 'stable-artifa', title: 'Stable', versionsCount: 2 };
    apiGet.mockResolvedValue({ data: { artifacts: [existing] } });

    const wiring = buildArtifactPublishWiring({
      artifactId: 'artifact_stable_id_123',
      type: 'html',
      content: '<p>hello</p>',
      title: 'Stable',
      userId: 'u1',
    });

    expect(await wiring.resolveExisting()).toEqual(existing);
  });
});
