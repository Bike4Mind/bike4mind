import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { firecrawlFetch, truncationMarker, webFetchTool } from './index';
import type { ToolContext } from '../../base/types';
import type { CitableSource } from '@bike4mind/common';
import { aggregateWebFetchContentTelemetry } from '../../../../telemetry';

const CAP = 50_000;

const adapters = {
  db: {
    adminSettings: { findBySettingName: async () => ({ settingValue: 'test-key' }) },
  },
} as unknown as Parameters<typeof firecrawlFetch>[0];

function makeContext(statusUpdate: ToolContext['statusUpdate']) {
  return {
    db: adapters.db,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() },
    statusUpdate,
  } as unknown as ToolContext;
}

async function runTool(url = 'https://example.com/doc') {
  const citables: CitableSource[] = [];
  const statusUpdate = vi.fn(async (q: Parameters<ToolContext['statusUpdate']>[0]) => {
    const emitted = q?.promptMeta?.citables as CitableSource[] | undefined;
    if (emitted) citables.push(...emitted);
  });
  const context = makeContext(statusUpdate);
  const result = await webFetchTool.implementation(context, {}).toolFn({ url });
  return { result: result as string, citable: citables[0] };
}

beforeEach(() => {
  scrapeUrl.mockClear();
});

describe('truncationMarker', () => {
  it('is ASCII-only and reports the cap and original length', () => {
    const marker = truncationMarker(90_000, CAP);
    expect(marker).toBe('\n\n[TRUNCATED at 50000 of ~90000 chars - content continues]');
    // Public repo: source strings must be plain ASCII (no em-dash / smart quotes).
    expect([...marker].every(ch => ch.charCodeAt(0) < 128)).toBe(true);
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
    expect(res.truncated).toBe(truncated);
    expect(res.cap).toBe(CAP);
    expect(res.extractedChars).toBe(Math.min(size, CAP));
    expect(res.markdown.length).toBe(Math.min(size, CAP));
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('webFetchTool result + citable', () => {
  it('appends the in-band marker and flags the citable when truncated', async () => {
    scrapeMarkdown = 'x'.repeat(200_000);
    const { result, citable } = await runTool();

    expect(result.endsWith(truncationMarker(200_000, CAP))).toBe(true);
    expect(result.length).toBe(CAP + truncationMarker(200_000, CAP).length);
    expect(citable.metadata.truncated).toBe(true);
    expect(citable.metadata.originalContentLength).toBe(200_000);
    expect(citable.metadata.contentLength).toBe(CAP);
    expect(citable.metadata.cap).toBe(CAP);
  });

  it('returns clean content with no marker and truncated=false when under the cap', async () => {
    scrapeMarkdown = 'x'.repeat(10_000);
    const { result, citable } = await runTool();

    expect(result).not.toContain('[TRUNCATED');
    expect(result.length).toBe(10_000);
    expect(citable.metadata.truncated).toBe(false);
    expect(citable.metadata.originalContentLength).toBe(10_000);
    expect(citable.metadata.contentLength).toBe(10_000);
  });
});

// End-to-end boundary corpus: tool result marker <-> citable metadata <-> telemetry rollup
// stay consistent across the cap boundary (issue #452).
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

    // Model-facing result carries the marker only when truncated.
    expect(result.includes('[TRUNCATED')).toBe(truncated);
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
