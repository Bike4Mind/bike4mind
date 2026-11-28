import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { ChatModels, EXCERPT_MAX, ForbiddenError, insufficientCreditsError } from '@bike4mind/common';
import { AI_ACCESS_REVOKED_MESSAGE } from '../userService/accountState';

// Same mocking shape as LakeMemoryExtractionService.test.ts: fake the adapters so evaluate()'s
// getAvailableModels + getLlmByModel resolve to a backend whose `complete` streams whatever canned
// response the test sets, which SmallLLMService.completeJSON then parses/validates for real.
let nextResponse = '';
let completeCalls = 0;
let nextError: Error | null = null;
let nextInfo: { inputTokens: number; outputTokens: number } | undefined;
let nextComplete: ((opts: { abortSignal?: AbortSignal }) => Promise<void>) | null = null;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: async () => [{ id: ChatModels.GPT4_1_MINI }],
    getLlmByModel: () => ({
      complete: async (
        _model: string,
        _messages: unknown,
        opts: { abortSignal?: AbortSignal },
        callback: (texts: string[], info?: unknown) => Promise<void>
      ) => {
        completeCalls++;
        if (nextComplete) return nextComplete(opts);
        if (nextError) throw nextError;
        await callback([nextResponse], nextInfo);
      },
    }),
  };
});

const { LakeContradictionReadingService, MODEL_CONTRADICTION_TIMEOUT_MS } =
  await import('./LakeContradictionReadingService');

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
  nextInfo = undefined;
  nextComplete = null;
});

afterEach(() => {
  vi.useRealTimers();
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

    // Asserted against EXCERPT_MAX, the constant this test is named for - not merely "shorter than
    // the input", which any trim at all satisfies and which says nothing about the bound holding.
    expect(result?.[0].documents[0].excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
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
  it('discards a contradiction that cites the same document twice', async () => {
    // knownIds proves each id was SUPPLIED; it does not prove two different documents disagree. A
    // self-contradiction is exactly what the prompt rules out and what the schema doc asserts
    // against, and unfiltered it would be emitted as cross-document with documentCount: 2.
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'refund window',
          documents: [
            { fabFileId: 'a', excerpt: '30 days' },
            { fabFileId: 'a', excerpt: '60 days' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result).toEqual([]);
  });

  it('collapses a repeated citation so documentCount cannot overstate the span', async () => {
    nextResponse = JSON.stringify({
      contradictions: [
        {
          subject: 'refund window',
          documents: [
            { fabFileId: 'a', excerpt: '30 days' },
            { fabFileId: 'a', excerpt: '30 days again' },
            { fabFileId: 'b', excerpt: '60 days' },
          ],
        },
      ],
    });

    const result = await service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')] });

    expect(result).toHaveLength(1);
    expect(result![0].documents.map(d => d.fabFileId)).toEqual(['a', 'b']);
  });

  it('rethrows a credit refusal from the meter without calling the provider', async () => {
    const refusal = insufficientCreditsError('no credits');
    const meter = vi.fn().mockRejectedValue(refusal);

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).rejects.toBe(refusal);
    expect(completeCalls).toBe(0);
  });

  it('treats any other meter failure as a bad batch rather than ending the run', async () => {
    const meter = vi.fn().mockRejectedValue(new Error('ledger unavailable'));

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).resolves.toBeNull();
    expect(completeCalls).toBe(0);
  });

  it("rethrows the owner's AI-access refusal from the meter without calling the provider", async () => {
    const refusal = new ForbiddenError(AI_ACCESS_REVOKED_MESSAGE);
    const meter = vi.fn().mockRejectedValue(refusal);

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).rejects.toBe(refusal);
    expect(completeCalls).toBe(0);
  });

  it("settles each funded call through the meter with the provider's reported usage", async () => {
    nextResponse = JSON.stringify({ contradictions: [] });
    nextInfo = { inputTokens: 1200, outputTokens: 40 };
    const settle = vi.fn().mockResolvedValue(1);
    const meter = vi.fn().mockResolvedValue({ settle, refund: vi.fn() });

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).resolves.toEqual([]);

    expect(meter).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 1200, outputTokens: 40 }));
  });

  it('meters the retry as its own call when the first response does not parse', async () => {
    nextResponse = 'not json';
    const settle = vi.fn().mockResolvedValue(1);
    const meter = vi.fn().mockResolvedValue({ settle, refund: vi.fn() });

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).resolves.toBeNull();

    expect(completeCalls).toBe(2);
    expect(meter).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('propagates a settlement failure after a valid response without buying a second provider call', async () => {
    nextResponse = JSON.stringify({ contradictions: [] });
    nextInfo = { inputTokens: 1200, outputTokens: 40 };
    const ledgerDown = new Error('ledger unavailable');
    const meter = vi.fn().mockResolvedValue({ settle: vi.fn().mockRejectedValue(ledgerDown), refund: vi.fn() });

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).rejects.toMatchObject({
      cause: ledgerDown,
    });
    expect(completeCalls).toBe(1);
    expect(meter).toHaveBeenCalledOnce();
  });

  it('propagates a refund failure after a provider error without buying a second provider call', async () => {
    nextError = new Error('provider unavailable');
    const ledgerDown = new Error('ledger unavailable');
    const meter = vi.fn().mockResolvedValue({ settle: vi.fn(), refund: vi.fn().mockRejectedValue(ledgerDown) });

    await expect(service.evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })).rejects.toMatchObject({
      cause: ledgerDown,
    });
    expect(completeCalls).toBe(1);
  });

  it('aborts a timed-out call and closes every reservation before returning', async () => {
    vi.useFakeTimers();
    let reserved = 0;
    let closed = 0;
    // Slow ledger writes: a caller that does not await them returns with the reservation still open.
    const close = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      closed++;
      return 0;
    };
    const meter = vi.fn(async () => {
      reserved++;
      return { settle: close, refund: close };
    });
    // A provider that never answers on its own and stops a moment after it is aborted.
    nextComplete = ({ abortSignal }) =>
      new Promise<void>((_, reject) => {
        abortSignal?.addEventListener('abort', () => setTimeout(() => reject(abortSignal.reason), 5), { once: true });
      });

    const outcome = service
      .evaluate({ apiKeyTable, documents: [doc('a'), doc('b')], meter })
      .then(result => ({ result, reserved, closed }));
    await vi.advanceTimersByTimeAsync(MODEL_CONTRADICTION_TIMEOUT_MS * 3);

    // A timeout is an inference failure, so the one retry still runs; neither reservation outlives the call.
    await expect(outcome).resolves.toEqual({ result: null, reserved: 2, closed: 2 });
    expect(completeCalls).toBe(2);
  });
});
