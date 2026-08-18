import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { renderArtifactIndexHtml } from '@server/services/publish';

// Integration guard for the server-authoritative render branch of finalize (issue #1491): a draft
// that signals a non-react `artifactType` uploads RAW artifact content as index.html; finalize must
// render it into the canonical published page (byte-identical to renderArtifactIndexHtml), recompute
// size/sha, and promote the RENDERED bytes - while a draft with NO artifactType (an already-inert
// bundle from the current web client) must promote its uploaded bytes unchanged (backward compat).
// Keeps the REAL renderArtifactIndexHtml + validateBundle and stubs the heavy service surface.

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockDownload: vi.fn(),
  mockUpload: vi.fn(() => Promise.resolve()),
}));

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

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
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

const DRAFT_ID = '33333333-3333-4333-8333-333333333333';

const manifest = (over: Record<string, unknown>) => ({
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'art',
  title: 'My Artifact',
  visibility: 'public',
  files: [{ path: 'index.html', size: 1, mimeType: 'text/html' }],
  ...over,
});

const setDraft = (m: Record<string, unknown>, rawIndexHtml: string) => {
  mockDownload.mockImplementation((key: string) =>
    key.endsWith('_manifest.json')
      ? Promise.resolve(Buffer.from(JSON.stringify(m)))
      : Promise.resolve(Buffer.from(rawIndexHtml))
  );
};

const run = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: 'owner1', isAdmin: false, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const promotedIndexHtml = () => {
  const call = mockUpload.mock.calls.find(c => String(c[1]).endsWith('index.html'));
  return (call![0] as Buffer).toString('utf-8');
};
const savedSet = () => (mockFindOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null);
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'public', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

describe('finalize - server-authoritative render branch', () => {
  it('renders a raw svg draft to the canonical page and promotes the RENDERED bytes (200)', async () => {
    const rawSvg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    setDraft(manifest({ source: { kind: 'bundle', artifactId: 'a1', artifactType: 'svg' } }), rawSvg);
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const promoted = promotedIndexHtml();
    expect(promoted).toBe(renderArtifactIndexHtml('svg', rawSvg, 'My Artifact'));
    expect(promoted.startsWith('<!doctype html>')).toBe(true);
    expect(promoted).toContain(rawSvg); // inline svg is embedded, not escaped

    // size + sha recomputed on the FINAL rendered bytes.
    const set = savedSet();
    expect((set.size as { totalBytes: number }).totalBytes).toBe(Buffer.byteLength(promoted, 'utf-8'));
    expect(typeof set.sha256Index).toBe('string');
  });

  it('renders a raw code draft into an escaped code view (200)', async () => {
    const rawCode = 'const x = 1 < 2 && "y" > 0;';
    setDraft(manifest({ source: { kind: 'bundle', artifactId: 'a1', artifactType: 'code' } }), rawCode);
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const promoted = promotedIndexHtml();
    expect(promoted).toBe(renderArtifactIndexHtml('code', rawCode, 'My Artifact'));
    expect(promoted).toContain('<pre><code>const x = 1 &lt; 2 &amp;&amp; &quot;y&quot; &gt; 0;</code></pre>');
  });

  it('promotes an already-inert bundle unchanged when no artifactType is signaled (backward compat)', async () => {
    const inert = '<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Prebuilt</h1></body></html>';
    setDraft(manifest({ source: { kind: 'bundle', artifactId: 'a1' } }), inert);
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(promotedIndexHtml()).toBe(inert); // rendered nowhere - served exactly as uploaded
  });
});
