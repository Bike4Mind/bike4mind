import { describe, it, expect, vi, beforeEach } from 'vitest';

const createFirecrawlApp = vi.fn();
vi.mock('../webfetch/firecrawlApp', () => ({
  createFirecrawlApp: (...a: unknown[]) => createFirecrawlApp(...a),
}));

const resolveWebSearchProvider = vi.fn();
vi.mock('../websearch', () => ({
  resolveWebSearchProvider: (...a: unknown[]) => resolveWebSearchProvider(...a),
}));

const plainFetchScrape = vi.fn(async () => ({ markdown: 'plain content' }));
vi.mock('../webfetch/plainFetch', () => ({
  plainFetchScrape: (...a: unknown[]) => plainFetchScrape(...a),
}));

// getFirecrawlConfig runs for real but reads only context.db (mocked to return no settings);
// createFirecrawlApp is mocked, so its result is what actually decides the Firecrawl branch.

import { performDeepResearch } from './index';
import type { ToolContext } from '../../base/types';

const ANALYSIS_STOP = JSON.stringify({
  analysis: { summary: 'done', gaps: [], nextSteps: [], shouldContinue: false },
});

function makeContext() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  return {
    userId: 'user-1',
    user: { organizationId: undefined },
    logger,
    db: { adminSettings: { findBySettingName: vi.fn(async () => null) } },
    llm: {
      complete: vi.fn(
        async (_model: string, _msgs: unknown, _opts: unknown, cb: (c: string[], i?: unknown) => void) => {
          await cb([ANALYSIS_STOP], undefined);
        }
      ),
    },
    statusUpdate: vi.fn(),
    onFinish: vi.fn(),
  } as unknown as ToolContext;
}

const firecrawlApp = () => ({
  search: vi.fn(async () => ({ data: [{ url: 'https://fc.example/1', title: 'FC', description: 'd' }] })),
  scrapeUrl: vi.fn(async () => ({ markdown: 'firecrawl content', error: null })),
});

const searchProvider = () => ({
  name: 'searxng' as const,
  search: vi.fn(async () => [{ url: 'https://sx.example/1', title: 'SX', snippet: 's' }]),
});

beforeEach(() => {
  createFirecrawlApp.mockReset();
  resolveWebSearchProvider.mockReset();
  plainFetchScrape.mockClear();
});

describe('performDeepResearch discovery precedence', () => {
  it('uses Firecrawl for discovery when both Firecrawl and a provider are configured', async () => {
    const app = firecrawlApp();
    const provider = searchProvider();
    createFirecrawlApp.mockReturnValue(app);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const result = await performDeepResearch(
      makeContext(),
      { topic: 'quantum computing' },
      { maxDepth: 1, duration: 1 }
    );

    expect(result.success).toBe(true);
    expect(app.search).toHaveBeenCalled();
    expect(provider.search).not.toHaveBeenCalled(); // hosted stays byte-identical: no SerpAPI/SearXNG burn
  });

  it('uses the web-search provider for discovery when Firecrawl is absent', async () => {
    const provider = searchProvider();
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const result = await performDeepResearch(
      makeContext(),
      { topic: 'quantum computing' },
      { maxDepth: 1, duration: 1 }
    );

    expect(result.success).toBe(true);
    expect(provider.search).toHaveBeenCalled();
    // Extraction falls back to the keyless plain-fetch reader when Firecrawl is absent.
    expect(plainFetchScrape).toHaveBeenCalled();
  });

  it('fails when neither a provider nor Firecrawl is configured', async () => {
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(null);

    const result = await performDeepResearch(
      makeContext(),
      { topic: 'quantum computing' },
      { maxDepth: 1, duration: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/web search provider|Firecrawl/i);
  });
});
