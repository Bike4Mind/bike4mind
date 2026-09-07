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
  isPdfUrl: (url: string) => url.toLowerCase().endsWith('.pdf'),
}));

// getFirecrawlConfig runs for real but reads only context.db (mocked to return no settings);
// createFirecrawlApp is mocked, so its result is what actually decides the Firecrawl branch.

import { performDeepResearch } from './index';
import type { ToolContext } from '../../base/types';

const ANALYSIS_STOP = JSON.stringify({
  analysis: { summary: 'done', gaps: [], nextSteps: [], shouldContinue: false },
});

// Planner output that keeps the research loop fed: a gap, shouldContinue, and a follow-up query.
// Needed to prove the loop is stopped by cancellation rather than by simply running dry.
const ANALYSIS_CONTINUE = JSON.stringify({
  analysis: {
    summary: 'more to do',
    gaps: ['gap'],
    nextSteps: ['next'],
    shouldContinue: true,
    nextSearchTopic: 'follow-up query',
  },
});

function makeContext(getAbortSignal?: () => AbortSignal | undefined) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  return {
    getAbortSignal,
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

  it('skips PDF URLs in keyless extraction instead of feeding a "cannot extract" notice to the planner', async () => {
    const provider = {
      name: 'searxng' as const,
      search: vi.fn(async () => [{ url: 'https://sx.example/paper.pdf', title: 'PDF', snippet: 's' }]),
    };
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const result = await performDeepResearch(
      makeContext(),
      { topic: 'quantum computing' },
      { maxDepth: 1, duration: 1 }
    );

    expect(result.success).toBe(true);
    expect(provider.search).toHaveBeenCalled();
    expect(plainFetchScrape).not.toHaveBeenCalled(); // keyless reader cannot parse PDFs
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

/**
 * Cancellation has to end the research LOOP, not just the in-flight analysis sub-call.
 * Every phase of an iteration (searcher calls, content extraction, analysis) is separately
 * billable and each one's catch swallows its own error, so a run that only threaded the signal
 * into llm.complete would keep searching to maxDepth after Stop - each analysis aborting
 * instantly while the web searches around it still burned real quota.
 */
describe('performDeepResearch honors the turn abort signal', () => {
  it('does no search work at all when the turn is already aborted', async () => {
    const provider = searchProvider();
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const controller = new AbortController();
    controller.abort();

    const result = await performDeepResearch(
      makeContext(() => controller.signal),
      { topic: 'quantum computing' },
      { maxDepth: 3, duration: 1 }
    );

    expect(result.success).toBe(true);
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('stops after the in-flight iteration instead of running to maxDepth', async () => {
    const controller = new AbortController();
    // Stop pressed while the first iteration's search is in flight.
    const provider = {
      name: 'searxng' as const,
      search: vi.fn(async () => {
        controller.abort();
        return [{ url: 'https://sx.example/1', title: 'SX', snippet: 's' }];
      }),
    };
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const context = makeContext(() => controller.signal);
    // The planner must keep feeding the loop work, or it would run out of queries after the
    // first iteration and this would pass with no abort handling at all.
    (context.llm.complete as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_model: string, _msgs: unknown, _opts: unknown, cb: (c: string[], i?: unknown) => void) => {
        await cb([ANALYSIS_CONTINUE], undefined);
      }
    );

    await performDeepResearch(context, { topic: 'quantum computing' }, { maxDepth: 5, duration: 1 });

    expect(provider.search).toHaveBeenCalledTimes(1);
  });

  it('passes the signal into its own analysis sub-call', async () => {
    const provider = searchProvider();
    createFirecrawlApp.mockReturnValue(null);
    resolveWebSearchProvider.mockResolvedValue(provider);

    const controller = new AbortController();
    const context = makeContext(() => controller.signal);

    await performDeepResearch(context, { topic: 'quantum computing' }, { maxDepth: 1, duration: 1 });

    const complete = context.llm.complete as unknown as ReturnType<typeof vi.fn>;
    expect(complete).toHaveBeenCalled();
    for (const call of complete.mock.calls) {
      expect((call[2] as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);
    }
  });
});
