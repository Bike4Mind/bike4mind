import { describe, it, expect } from 'vitest';
import { estimateEmbeddingCostUsd, estimateEmbeddingTokens } from './embeddingCostEstimate';

describe('estimateEmbeddingTokens', () => {
  it('rounds up - a 1-byte text file yields at least 1 token, never 0', () => {
    expect(estimateEmbeddingTokens([{ name: 'a.txt', size: 1 }])).toBeGreaterThanOrEqual(1);
  });

  it('is monotonic in file size', () => {
    const small = estimateEmbeddingTokens([{ name: 'a.txt', size: 1000 }]);
    const large = estimateEmbeddingTokens([{ name: 'a.txt', size: 10_000 }]);
    expect(large).toBeGreaterThan(small);
  });

  it('applies a lower yield to zip-container formats (Word/Excel) than plain text', () => {
    const text = estimateEmbeddingTokens([{ name: 'a.txt', size: 100_000 }]);
    const word = estimateEmbeddingTokens([{ name: 'a.docx', size: 100_000 }]);
    expect(word).toBeLessThan(text);
  });

  it('applies an even lower yield to PDF than to Word', () => {
    const word = estimateEmbeddingTokens([{ name: 'a.docx', size: 100_000 }]);
    const pdf = estimateEmbeddingTokens([{ name: 'a.pdf', size: 100_000 }]);
    expect(pdf).toBeLessThan(word);
  });

  it('yields 0 tokens for images - nothing OCRs them today', () => {
    expect(estimateEmbeddingTokens([{ name: 'photo.png', size: 500_000 }])).toBe(0);
  });

  it('defaults an unknown extension to the conservative full-yield estimate', () => {
    const unknown = estimateEmbeddingTokens([{ name: 'file.xyz', size: 100_000 }]);
    const text = estimateEmbeddingTokens([{ name: 'file.txt', size: 100_000 }]);
    expect(unknown).toBe(text);
  });

  it('sums across multiple files', () => {
    const one = estimateEmbeddingTokens([{ name: 'a.txt', size: 1000 }]);
    const two = estimateEmbeddingTokens([
      { name: 'a.txt', size: 1000 },
      { name: 'b.txt', size: 1000 },
    ]);
    expect(two).toBe(one * 2);
  });

  it('returns 0 (never NaN) for a zero-size file list', () => {
    expect(estimateEmbeddingTokens([{ name: 'empty.txt', size: 0 }])).toBe(0);
    expect(estimateEmbeddingTokens([])).toBe(0);
  });
});

describe('estimateEmbeddingCostUsd', () => {
  it('returns 0 for 0 tokens without calling the pricing table (no console.error on unpriced model)', () => {
    expect(estimateEmbeddingCostUsd(0, 'text-embedding-3-small')).toBe(0);
  });

  it('computes a positive cost for a real priced model', () => {
    expect(estimateEmbeddingCostUsd(1_000_000, 'text-embedding-3-small')).toBeGreaterThan(0);
  });

  it('returns exactly 0 for every Ollama embedding model (self-host, no per-token cost)', () => {
    const ollamaModels = [
      'qwen3-embedding:0.6b',
      'qwen3-embedding:4b',
      'qwen3-embedding:8b',
      'nomic-embed-text',
      'mxbai-embed-large',
      'bge-m3',
      'snowflake-arctic-embed',
    ];
    for (const model of ollamaModels) {
      expect(estimateEmbeddingCostUsd(1_000_000, model)).toBe(0);
    }
  });
});
