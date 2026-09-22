import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';

// Same mocking shape as LakeMemoryExtractionService.test.ts: fake the adapters so evaluate()'s
// getAvailableModels + getLlmByModel resolve to a backend whose `complete` streams whatever canned
// response the test sets, which SmallLLMService.completeJSON then parses/validates for real.
let nextResponse = '';
let completeCalls = 0;
let nextError: Error | null = null;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: async () => [{ id: ChatModels.GPT4_1_MINI }],
    getLlmByModel: () => ({
      complete: async (
        _model: string,
        _messages: unknown,
        _opts: unknown,
        callback: (texts: string[], info?: unknown) => Promise<void>
      ) => {
        completeCalls++;
        if (nextError) throw nextError;
        await callback([nextResponse], undefined);
      },
    }),
  };
});

const { LakeContradictionReadingService } = await import('./LakeContradictionReadingService');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const apiKeyTable = { openai: 'k-openai' } as ApiKeyTable;
const service = new LakeContradictionReadingService(silentLogger);

const doc = (fabFileId: string, text = 'some policy text') => ({ fabFileId, fileName: `${fabFileId}.pdf`, text });

beforeEach(() => {
  completeCalls = 0;
  nextResponse = '';
  nextError = null;
});

describe('LakeContradictionReadingService.evaluate', () => {
  it('skips the LLM call entirely with fewer than two documents', async () => {
    const result = await service.evaluate({ apiKeyTable, documents: [doc('a')] });
    expect(result).toEqual([]);
    expect(completeCalls).toBe(0);
  });

  it('parses a grounded contradiction citing documents it was actually given', async () => {
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'refund window',
          documents: [
            { fabFileId: 'a', excerpt: 'Refunds are available for 30 days.' },
            { fabFileId: 'b', excerpt: 'Refunds are final; no window applies.' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result).toHaveLength(1);
    expect(result?.[0].subject).toBe('refund window');
    expect(result?.[0].documents).toHaveLength(2);
  });

  it('drops a hallucinated document id and discards the contradiction if fewer than two sources remain', async () => {
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'refund window',
          documents: [
            { fabFileId: 'a', excerpt: 'Refunds are available for 30 days.' },
            { fabFileId: 'not-in-batch', excerpt: 'Refunds are final.' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result).toEqual([]);
  });

  it('keeps a contradiction when only the extra, non-hallucinated sources are trimmed', async () => {
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'refund window',
          documents: [
            { fabFileId: 'a', excerpt: 'Refunds are available for 30 days.' },
            { fabFileId: 'b', excerpt: 'Refunds are final.' },
            { fabFileId: 'not-in-batch', excerpt: 'irrelevant.' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result).toHaveLength(1);
    expect(result?.[0].documents.map(d => d.fabFileId).sort()).toEqual(['a', 'b']);
  });

  it('trims an excerpt down to EXCERPT_MAX', async () => {
    const longExcerpt = 'x'.repeat(1000);
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'long excerpt',
          documents: [
            { fabFileId: 'a', excerpt: longExcerpt },
            { fabFileId: 'b', excerpt: 'short' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result?.[0].documents[0].excerpt.length).toBeLessThan(longExcerpt.length);
  });

  it('returns an empty array when the model reports no contradictions', async () => {
    nextResponse = JSON.stringify({ contradictions: [] });
    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });
    expect(result).toEqual([]);
  });

  it('fails soft (returns null) on a malformed response', async () => {
    nextResponse = 'not json at all';
    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });
    expect(result).toBeNull();
  });

  it('fails soft (returns null) when the LLM call throws', async () => {
    nextError = new Error('provider unavailable');
    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });
    expect(result).toBeNull();
  });
});
