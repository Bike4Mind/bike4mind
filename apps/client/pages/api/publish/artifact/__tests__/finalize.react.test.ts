import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Integration guard for the React branch of finalize (issue #21): a React draft uploads RAW JSX as
// index.html; finalize must transpile it, recompute size/sha, promote the INERT bundle (not the raw
// JSX), and 200 - while an unsupported-dep / bad-JSX React draft must land a clean 422 (never a
// broken publish). Keeps the REAL buildReactArtifactBundle + validateBundle (the logic under test)
// and stubs only the heavy permission/quota/path/DB/storage surface.

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

// Keep the REAL buildReactArtifactBundle + validateBundle (that's what we're exercising); stub the
// rest of the heavy publish-service surface so the handler reaches the transpile + upsert.
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
    buildPublishS3KeyPrefix: () => 'user/owner1/counter/',
    buildPublishUrlPath: () => '/p/u/owner1/counter',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
  };
});

import handler from '../finalize';

const DRAFT_ID = '22222222-2222-4222-8222-222222222222';

const COUNTER_JSX = `import { useState } from 'react';
function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
export default Counter;`;

const RECHARTS_JSX = `import { LineChart } from 'recharts';
export default function C() {
  return <LineChart />;
}`;

const reactManifest = (rawSource: string) => ({
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'counter',
  title: 'Counter',
  visibility: 'public',
  source: { kind: 'bundle', artifactId: 'a1', artifactType: 'react' },
  files: [{ path: 'index.html', size: rawSource.length, mimeType: 'text/html' }],
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

const savedSet = () => (mockFindOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null); // first publish (no previous version)
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'public', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

describe('finalize - React artifact transpile branch', () => {
  it('transpiles the React draft and promotes the INERT bundle, recomputing size/sha (200)', async () => {
    setDraft(reactManifest(COUNTER_JSX), COUNTER_JSX);
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);

    // The promoted index.html is the transpiled bundle, NOT the raw JSX that was uploaded.
    const indexUpload = mockUpload.mock.calls.find(c => String(c[1]).endsWith('index.html'));
    expect(indexUpload).toBeTruthy();
    const promotedHtml = (indexUpload![0] as Buffer).toString('utf-8');
    expect(promotedHtml).toContain('React.createElement'); // transpiled
    expect(promotedHtml).not.toContain('import { useState }'); // raw JSX is not what gets served

    // size + sha were recomputed on the FINAL bytes before the record was written.
    const set = savedSet();
    expect((set.size as { totalBytes: number }).totalBytes).toBe(Buffer.byteLength(promotedHtml, 'utf-8'));
    expect(typeof set.sha256Index).toBe('string');
  });

  it('rejects a React draft importing an unsupported dep with a clean 422 (nothing promoted)', async () => {
    setDraft(reactManifest(RECHARTS_JSX), RECHARTS_JSX);
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    const body = res._getJSONData() as { violations?: Array<{ message: string }> };
    expect(body.violations?.[0]?.message ?? '').toMatch(/not publishable yet|recharts/i);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled(); // no upsert - nothing published
  });
});
