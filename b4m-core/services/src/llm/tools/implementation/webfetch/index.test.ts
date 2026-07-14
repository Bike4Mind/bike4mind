import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Controls what the mocked Firecrawl scrapeUrl returns for each test.
let scrapeMarkdown = '';
const scrapeUrl = vi.fn(async () => ({
  markdown: scrapeMarkdown,
  metadata: { title: 'Test Title' },
}));

vi.mock('./firecrawlApp', () => ({
  FirecrawlApp: class {
    scrapeUrl = scrapeUrl;
  },
  resolveFirecrawlApp: (x: unknown) => x,
}));

import { firecrawlFetch, truncationMarker, webFetchBody, webFetchTool } from './index';
import type { ToolContext } from '../../base/types';
import type { CitableSource } from '@bike4mind/common';
import { aggregateWebFetchContentTelemetry } from '../../../../telemetry';

const CAP = 50_000;

const adapters = {
  db: {
    adminSettings: { findBySettingName: async () => ({ settingValue: 'test-key' }) },
  },
} as unknown as Parameters<typeof firecrawlFetch>[0];

// Build a minimal fetch Response-like object for the llms.txt probe.
function fetchRes(status: number, contentType = 'text/plain; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  } as unknown as Response;
}

// The llms.txt probe hits global fetch; stub it so tests never touch the network. Default: 404
// (nothing advertised) so the truncation/boundary suites keep their pre-#497 expectations.
const fetchMock = vi.fn(async () => fetchRes(404));
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.stubGlobal('fetch', realFetch);
});

function makeContext(statusUpdate: ToolContext['statusUpdate']) {
  return {
    db: adapters.db,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() },
    statusUpdate,
  } as unknown as ToolContext;
}

async function runTool(url = 'https://example.com/doc', offset?: number) {
  const citables: CitableSource[] = [];
  const statusUpdate = vi.fn(async (q: Parameters<ToolContext['statusUpdate']>[0]) => {
    const emitted = q?.promptMeta?.citables as CitableSource[] | undefined;
    if (emitted) citables.push(...emitted);
  });
  const context = makeContext(statusUpdate);
  const result = await webFetchTool.implementation(context, {}).toolFn({ url, offset });
  return { result: result as string, citable: citables[0] };
}

beforeEach(() => {
  scrapeUrl.mockClear();
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => fetchRes(404));
});

describe('truncationMarker', () => {
  it('is ASCII-only and reports the window plus the next offset to continue', () => {
    const marker = truncationMarker({ offset: 0, extractedChars: CAP, originalChars: 90_000 });
    expect(marker).toBe(
      '\n\n[web_fetch: showing chars 0-50000 of ~90000. More content remains - ' +
        'call web_fetch again with the same url and offset=50000 to continue.]'
    );
    // Public repo: source strings must be plain ASCII (no em-dash / smart quotes).
    expect([...marker].every(ch => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it('reports the correct next offset for a mid-document chunk', () => {
    const marker = truncationMarker({ offset: CAP, extractedChars: CAP, originalChars: 200_000 });
    expect(marker).toContain('showing chars 50000-100000 of ~200000');
    expect(marker).toContain('offset=100000 to continue');
  });

  it('appends an llms.txt hint when one is advertised', () => {
    const marker = truncationMarker({
      offset: 0,
      extractedChars: CAP,
      originalChars: 200_000,
      llmsTxtUrl: 'https://example.com/llms-full.txt',
    });
    expect(marker).toContain('https://example.com/llms-full.txt');
    expect([...marker].every(ch => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('webFetchBody', () => {
  it('returns a continuation marker when more content remains', () => {
    const body = webFetchBody({
      markdown: 'x'.repeat(CAP),
      extractedChars: CAP,
      originalChars: 120_000,
      offset: 0,
      truncated: true,
      cap: CAP,
      durationMs: 1,
    });
    expect(body.endsWith(truncationMarker({ offset: 0, extractedChars: CAP, originalChars: 120_000 }))).toBe(true);
  });

  it('returns the plain chunk with no marker when nothing remains', () => {
    const body = webFetchBody({
      markdown: 'x'.repeat(10_000),
      extractedChars: 10_000,
      originalChars: 10_000,
      offset: 0,
      truncated: false,
      cap: CAP,
      durationMs: 1,
    });
    expect(body).toBe('x'.repeat(10_000));
  });

  it('returns a beyond-end note when the offset is at or past the end', () => {
    const body = webFetchBody({
      markdown: '',
      extractedChars: 0,
      originalChars: 120_000,
      offset: 120_000,
      truncated: false,
      cap: CAP,
      durationMs: 1,
    });
    expect(body).toBe(
      '[web_fetch: offset 120000 is at or beyond the end of the content (~120000 chars); nothing further to read.]'
    );
  });
});

describe('firecrawlFetch truncation boundary', () => {
  it.each([
    { label: '10K (well under cap)', size: 10_000, truncated: false },
    { label: '49999 (just under cap)', size: 49_999, truncated: false },
    { label: '50000 (exactly at cap)', size: 50_000, truncated: false },
    { label: '51000 (just over cap)', size: 51_000, truncated: true },
    { label: '200K (far over cap)', size: 200_000, truncated: true },
  ])('$label -> truncated=$truncated', async ({ size, truncated }) => {
    scrapeMarkdown = 'x'.repeat(size);
    const res = await firecrawlFetch(adapters, 'https://example.com/doc');

    expect(res.originalChars).toBe(size);
    expect(res.offset).toBe(0);
    expect(res.truncated).toBe(truncated);
    expect(res.cap).toBe(CAP);
    expect(res.extractedChars).toBe(Math.min(size, CAP));
    expect(res.markdown.length).toBe(Math.min(size, CAP));
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('firecrawlFetch offset continuation', () => {
  // A 120K doc pages into 50K + 50K + 20K chunks.
  it.each([
    { label: 'first chunk', offset: 0, expectedLen: CAP, truncated: true },
    { label: 'middle chunk', offset: CAP, expectedLen: CAP, truncated: true },
    { label: 'final partial chunk', offset: 100_000, expectedLen: 20_000, truncated: false },
    { label: 'exactly at end', offset: 120_000, expectedLen: 0, truncated: false },
    { label: 'past the end', offset: 500_000, expectedLen: 0, truncated: false },
  ])('$label (offset=$offset)', async ({ offset, expectedLen, truncated }) => {
    scrapeMarkdown = 'x'.repeat(120_000);
    const res = await firecrawlFetch(adapters, 'https://example.com/doc', { offset });

    expect(res.offset).toBe(offset);
    expect(res.originalChars).toBe(120_000);
    expect(res.extractedChars).toBe(expectedLen);
    expect(res.markdown.length).toBe(expectedLen);
    expect(res.truncated).toBe(truncated);
  });

  it('lets the model page through a long document via the tool', async () => {
    scrapeMarkdown = 'x'.repeat(120_000);

    const first = await runTool('https://example.com/doc');
    expect(first.result).toContain('offset=50000 to continue');

    const second = await runTool('https://example.com/doc', 50_000);
    expect(second.result).toContain('offset=100000 to continue');

    const third = await runTool('https://example.com/doc', 100_000);
    expect(third.result).not.toContain('[web_fetch:');
    expect(third.result.length).toBe(20_000);

    const beyond = await runTool('https://example.com/doc', 120_000);
    expect(beyond.result).toContain('nothing further to read');
  });
});

describe('webFetchTool result + citable', () => {
  it('appends the in-band marker and flags the citable when truncated', async () => {
    scrapeMarkdown = 'x'.repeat(200_000);
    const { result, citable } = await runTool();

    const marker = truncationMarker({ offset: 0, extractedChars: CAP, originalChars: 200_000 });
    expect(result.endsWith(marker)).toBe(true);
    expect(result.length).toBe(CAP + marker.length);
    expect(citable.metadata.truncated).toBe(true);
    expect(citable.metadata.originalContentLength).toBe(200_000);
    expect(citable.metadata.contentLength).toBe(CAP);
    expect(citable.metadata.cap).toBe(CAP);
  });

  it('returns clean content with no marker and truncated=false when under the cap', async () => {
    scrapeMarkdown = 'x'.repeat(10_000);
    const { result, citable } = await runTool();

    expect(result).not.toContain('[web_fetch:');
    expect(result.length).toBe(10_000);
    expect(citable.metadata.truncated).toBe(false);
    expect(citable.metadata.originalContentLength).toBe(10_000);
    expect(citable.metadata.contentLength).toBe(10_000);
  });
});

describe('firecrawlFetch llms.txt probe', () => {
  const bigDoc = () => {
    scrapeMarkdown = 'x'.repeat(200_000);
  };

  it('prefers /llms-full.txt when both are advertised', async () => {
    bigDoc();
    fetchMock.mockImplementation(async () => fetchRes(200));
    const res = await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(res.llmsTxtUrl).toBe('https://example.com/llms-full.txt');
  });

  it('falls back to /llms.txt when only the index is advertised', async () => {
    bigDoc();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/llms.txt') ? fetchRes(200) : fetchRes(404)
    );
    const res = await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(res.llmsTxtUrl).toBe('https://example.com/llms.txt');
  });

  it('surfaces the hint in the model-facing marker', async () => {
    bigDoc();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/llms-full.txt') ? fetchRes(200) : fetchRes(404)
    );
    const { result } = await runTool('https://example.com/docs/page');
    expect(result).toContain('https://example.com/llms-full.txt');
  });

  it('adds no hint when nothing is advertised', async () => {
    bigDoc();
    fetchMock.mockImplementation(async () => fetchRes(404));
    const res = await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(res.llmsTxtUrl).toBeUndefined();
  });

  it('ignores an SPA catch-all that answers 200 with HTML', async () => {
    bigDoc();
    fetchMock.mockImplementation(async () => fetchRes(200, 'text/html; charset=utf-8'));
    const res = await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(res.llmsTxtUrl).toBeUndefined();
  });

  it('never fails the fetch when the probe throws', async () => {
    bigDoc();
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    const res = await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(res.llmsTxtUrl).toBeUndefined();
    expect(res.extractedChars).toBe(CAP);
  });

  it('does not probe when the fetch is not truncated', async () => {
    scrapeMarkdown = 'x'.repeat(10_000);
    await firecrawlFetch(adapters, 'https://example.com/docs/page');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// End-to-end boundary corpus: tool result marker <-> citable metadata <-> telemetry rollup
// stay consistent across the cap boundary (issue #452; continuation semantics in #497).
describe('web_fetch truncation boundary corpus (marker + citable + telemetry)', () => {
  it.each([
    { size: 10_000, truncated: false },
    { size: 49_999, truncated: false },
    { size: 50_000, truncated: false },
    { size: 51_000, truncated: true },
    { size: 200_000, truncated: true },
  ])('$size chars -> truncated=$truncated everywhere', async ({ size, truncated }) => {
    scrapeMarkdown = 'x'.repeat(size);
    const { result, citable } = await runTool(`https://example.com/${size}`);

    // Model-facing result carries the continuation marker only when truncated.
    expect(result.includes('[web_fetch:')).toBe(truncated);
    // Citable metadata reflects the same truncation state and post-cap length.
    expect(citable.metadata.truncated).toBe(truncated);
    expect(citable.metadata.contentLength).toBe(Math.min(size, CAP));

    // Telemetry rollup derived from that citable agrees.
    const telemetry = aggregateWebFetchContentTelemetry([citable]);
    expect(telemetry.truncatedInvocationCount).toBe(truncated ? 1 : 0);
    expect(telemetry.maxExtractedChars).toBe(Math.min(size, CAP));
    expect(telemetry.totalExtractedChars).toBe(Math.min(size, CAP));
  });
});
