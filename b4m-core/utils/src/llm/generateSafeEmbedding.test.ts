import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { BoundEmbeddingModel } from '../embeddingProviders/runtime';
import { TiktokenTokenizer } from '../tokenCounting';
import { generateSafeEmbedding } from './utils';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const PROVIDER_LIMIT = 8192;

/** A bound model that, like the OpenAI provider, rejects any input over its per-input token limit. */
const strictModel = (countTokens: (text: string) => Promise<number>) => {
  const embedded: string[] = [];
  const model: BoundEmbeddingModel = {
    model: 'text-embedding-3-small',
    maxInputTokens: PROVIDER_LIMIT,
    embed: async inputs => {
      for (const input of inputs) {
        const count = await countTokens(input);
        if (count > PROVIDER_LIMIT) {
          throw new Error(`Input at index 0 exceeds ${PROVIDER_LIMIT} token limit (${count} tokens)`);
        }
        embedded.push(input);
      }
      return { vectors: inputs.map(() => [1, 2, 3]) };
    },
  };
  return { model, embedded };
};

/**
 * Deterministic CJK text, well under 3.5 chars per token, so the character estimate undercounts it.
 * Spaced into short words like real markup: one unbroken run is a single BPE pre-token, which tiktoken
 * encodes in superlinear time.
 */
const denseText = (length: number): string =>
  Array.from({ length }, (_, i) => (i % 8 === 7 ? ' ' : String.fromCharCode(0x4e00 + ((i * 7919) % 20000)))).join('');

describe('generateSafeEmbedding', () => {
  it('splits text the character estimate undercounts so every piece fits the provider limit', async () => {
    const tokenizer = new TiktokenTokenizer({ logger });
    const count = (text: string) => tokenizer.countTokens(text, 'text-embedding-3-small');
    const { model, embedded } = strictModel(count);
    // 20k chars estimates at ~5.7k tokens (under the limit) but counts far over it for real.
    const text = denseText(20_000);
    expect(await count(text)).toBeGreaterThan(PROVIDER_LIMIT);

    const vector = await generateSafeEmbedding(model, text, logger);

    expect(vector).toEqual([1, 2, 3]);
    expect(embedded.length).toBeGreaterThan(1);
    for (const piece of embedded) expect(await count(piece)).toBeLessThanOrEqual(8000);
    expect(embedded.join('')).toBe(text);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('halves an oversized character window and embeds every piece without dropping content', async () => {
    const oneTokenPerChar = async (text: string) => text.length;
    const { model, embedded } = strictModel(oneTokenPerChar);
    const text = 'x'.repeat(20_000);

    await generateSafeEmbedding(model, text, logger, oneTokenPerChar);

    expect(embedded.map(piece => piece.length)).toEqual([5000, 5000, 5000, 5000]);
    expect(embedded.join('')).toBe(text);
  });

  it('never counts a text longer than two windows in one piece', async () => {
    const counted: number[] = [];
    const recordingCounter = async (text: string) => {
      counted.push(text.length);
      return Math.ceil(text.length / 4);
    };
    const { model, embedded } = strictModel(recordingCounter);
    // Two 28k-char windows plus some: every count must be of a bounded window, never the whole text.
    const text = 'word '.repeat(12_000);

    await generateSafeEmbedding(model, text, logger, recordingCounter);

    expect(Math.max(...counted)).toBeLessThanOrEqual(28_000);
    expect(embedded.length).toBeGreaterThan(1);
  });

  it('embeds text within the limit in one call', async () => {
    const { model, embedded } = strictModel(async text => text.length);

    await generateSafeEmbedding(model, 'short prompt', logger, async text => text.length);

    expect(embedded).toEqual(['short prompt']);
  });

  it('never splits a surrogate pair', async () => {
    const oneTokenPerUnit = async (text: string) => text.length;
    const { model, embedded } = strictModel(oneTokenPerUnit);
    // 8001 UTF-16 units with an astral character straddling the midpoint.
    const text = 'a'.repeat(3999) + '\u{1F600}' + 'b'.repeat(4000);

    await generateSafeEmbedding(model, text, logger, oneTokenPerUnit);

    expect(embedded.join('')).toBe(text);
    for (const piece of embedded) expect(piece).not.toMatch(/[\ud800-\udbff]$|^[\udc00-\udfff]/);
  });
});
