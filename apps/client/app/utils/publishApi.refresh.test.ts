import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * refreshPublishedFromSource lands a new VERSION of an existing publication by
 * re-running the ordinary publish pipeline with the slug pinned. The cases that
 * matter are the ones where finalize's unconditional `$set` would otherwise change
 * something the owner did not ask to change.
 */

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost, patch: vi.fn(), delete: vi.fn() },
}));

// The bundler pulls brand config + the elision detector; neither is under test here.
vi.mock('@client/app/utils/shareFooter', () => ({
  buildShareFooterHtml: () => '<footer/>',
  buildSignupGateHtml: () => ({ styles: '', html: '' }),
}));

import { canRefreshFromSource, refreshPublishedFromSource } from './publishApi';
import type { ManagedArtifact } from './publishApi';

const row = (over: Partial<ManagedArtifact> = {}): ManagedArtifact =>
  ({
    publicId: 'pub-1',
    tier: 'user',
    scopeId: 'user-1',
    slug: 'my-slug',
    title: 'Published Title',
    visibility: 'private',
    commentPolicy: 'open',
    description: 'the blurb',
    source: { kind: 'bundle', artifactId: 'artifact_html_x_1_0' },
    ...over,
  }) as ManagedArtifact;

/** Wire the 3-step pipeline: artifact read -> upload-url -> S3 PUT -> finalize. */
function wirePipeline() {
  mockGet.mockResolvedValue({
    data: { artifact: { type: 'html', title: 'Source Title' }, content: { content: '<h1>fresh</h1>' } },
  });
  mockPost.mockImplementation((url: string) => {
    if (url.endsWith('/upload-url')) {
      return Promise.resolve({
        data: { draftId: 'd1', uploadUrls: [{ path: 'index.html', url: 'https://s3.example/put', expiresAt: 'x' }] },
      });
    }
    return Promise.resolve({ data: { publicId: 'pub-1', url: '/p/u/user-1/my-slug' } });
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
}

const uploadUrlBody = () => mockPost.mock.calls.find(c => String(c[0]).endsWith('/upload-url'))![1];

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  vi.unstubAllGlobals();
});

describe('canRefreshFromSource', () => {
  it('allows a bundle that carries its source artifactId', () => {
    expect(canRefreshFromSource(row())).toBe(true);
  });

  it('refuses a bundle published from outside the app (no artifactId to read back)', () => {
    expect(canRefreshFromSource(row({ source: { kind: 'bundle' } }))).toBe(false);
  });

  it('refuses reply and fabfile snapshots', () => {
    expect(canRefreshFromSource(row({ source: { kind: 'reply', artifactId: 'a' } }))).toBe(false);
    expect(canRefreshFromSource(row({ source: { kind: 'fabfile', artifactId: 'a' } }))).toBe(false);
  });
});

describe('refreshPublishedFromSource', () => {
  it('pins the existing slug and scope so finalize lands a VERSION, not a second page', async () => {
    wirePipeline();
    await refreshPublishedFromSource(row());

    const body = uploadUrlBody();
    expect(body.slug).toBe('my-slug');
    expect(body.tier).toBe('user');
    expect(body.scopeId).toBe('user-1');
  });

  it('carries visibility through - omitting it would make a private page PUBLIC', async () => {
    wirePipeline();
    await refreshPublishedFromSource(row({ visibility: 'private' }));
    expect(uploadUrlBody().visibility).toBe('private');
  });

  it('carries commentPolicy and description through, which finalize would otherwise reset', async () => {
    wirePipeline();
    await refreshPublishedFromSource(row());

    const body = uploadUrlBody();
    expect(body.commentPolicy).toBe('open');
    expect(body.description).toBe('the blurb');
  });

  it("takes the SOURCE artifact's current title (a refresh re-syncs from source)", async () => {
    wirePipeline();
    await refreshPublishedFromSource(row());
    expect(uploadUrlBody().title).toBe('Source Title');
  });

  it('falls back to the published title when the source has none', async () => {
    wirePipeline();
    mockGet.mockResolvedValue({ data: { artifact: { type: 'html' }, content: { content: '<h1>x</h1>' } } });
    await refreshPublishedFromSource(row());
    expect(uploadUrlBody().title).toBe('Published Title');
  });

  it('uploads the source content, and flags react so finalize transpiles it', async () => {
    wirePipeline();
    mockGet.mockResolvedValue({
      data: { artifact: { type: 'react', title: 'App' }, content: { content: 'export default () => <div/>;' } },
    });
    await refreshPublishedFromSource(row());

    const body = uploadUrlBody();
    expect(body.source).toEqual({ kind: 'bundle', artifactId: 'artifact_html_x_1_0', artifactType: 'react' });
    // React uploads RAW JSX; the server transpiles it at finalize.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe('export default () => <div/>;');
  });

  it('refuses a row with no source artifact before touching the network', async () => {
    await expect(refreshPublishedFromSource(row({ source: { kind: 'bundle' } }))).rejects.toThrow(
      /no source artifact/i
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses an empty source rather than publishing a blank version over a good one', async () => {
    mockGet.mockResolvedValue({ data: { artifact: { type: 'html', title: 'T' }, content: { content: '   ' } } });
    await expect(refreshPublishedFromSource(row())).rejects.toThrow(/no content/i);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses an unreadable source', async () => {
    mockGet.mockResolvedValue({ data: {} });
    await expect(refreshPublishedFromSource(row())).rejects.toThrow(/could not be read/i);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('surfaces a failed S3 upload instead of finalizing a half-written version', async () => {
    wirePipeline();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(refreshPublishedFromSource(row())).rejects.toThrow(/Upload failed \(403\)/);
    expect(mockPost.mock.calls.some(c => String(c[0]).endsWith('/finalize'))).toBe(false);
  });
});

describe('refreshPublishedFromSource - multi-file react', () => {
  const ENTRY = `import Stopwatch from './Stopwatch';\nexport default () => <Stopwatch />;`;
  const multiRow = () =>
    row({
      source: { kind: 'bundle', artifactId: 'entry-1', reactSiblings: ['Stopwatch'] } as ManagedArtifact['source'],
    });

  function wireMultiFile(siblings: Record<string, { id: string; content: string } | null>, sessionId = 'sess-1') {
    wirePipeline();
    mockGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/api/artifacts') {
        const hit = siblings[String(config?.params?.identifier)];
        return Promise.resolve({ data: { artifacts: hit ? [{ id: hit.id }] : [] } });
      }
      const sibling = Object.values(siblings).find(s => s && url.startsWith(`/api/artifacts/${s.id}?`));
      if (sibling)
        return Promise.resolve({ data: { artifact: { type: 'react' }, content: { content: sibling.content } } });
      return Promise.resolve({
        data: { artifact: { type: 'react', title: 'App', sessionId }, content: { content: ENTRY } },
      });
    });
  }

  it("re-reads each sibling's newest source by identifier in the entry's session and uploads them together", async () => {
    wireMultiFile({ Stopwatch: { id: 'sw-2', content: 'export default () => <b>v2</b>;' } });
    await refreshPublishedFromSource(multiRow());

    const lookup = mockGet.mock.calls.find(c => c[0] === '/api/artifacts');
    expect(lookup![1].params).toEqual({
      sessionId: 'sess-1',
      type: 'react',
      identifier: 'Stopwatch',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: 1,
    });
    expect(uploadUrlBody().source).toEqual({
      kind: 'bundle',
      artifactId: 'entry-1',
      artifactType: 'react',
      reactSiblings: ['Stopwatch'],
    });
    const put = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { body: string };
    expect(JSON.parse(put.body)).toEqual({ entry: ENTRY, files: { Stopwatch: 'export default () => <b>v2</b>;' } });
  });

  it('fails with a clear error, publishing nothing, when a sibling can no longer be found', async () => {
    wireMultiFile({ Stopwatch: null });
    await expect(refreshPublishedFromSource(multiRow())).rejects.toThrow(
      'The file "Stopwatch" this app imports can no longer be found in its chat'
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails when the entry is no longer linked to a chat session', async () => {
    wireMultiFile({ Stopwatch: { id: 'sw-2', content: 'x' } }, '');
    await expect(refreshPublishedFromSource(multiRow())).rejects.toThrow('no longer linked to a chat');
    expect(mockPost).not.toHaveBeenCalled();
  });
});
