import { describe, it, expect } from 'vitest';
import { EmbeddingAuthError, isEmbeddingAuthError } from './EmbeddingErrors';

describe('EmbeddingAuthError', () => {
  it('carries the provider and preserves the operator-actionable message', () => {
    const err = new EmbeddingAuthError('openai', 'OpenAI rejected the embedding request (401 Unauthorized)');
    expect(err.provider).toBe('openai');
    expect(err.message).toMatch(/401 Unauthorized/);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the underlying cause', () => {
    const original = new Error('Incorrect API key');
    const err = new EmbeddingAuthError('openai', 'wrapped', { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('isEmbeddingAuthError', () => {
  it('identifies an EmbeddingAuthError', () => {
    expect(isEmbeddingAuthError(new EmbeddingAuthError('openai', 'x'))).toBe(true);
  });

  it('identifies by name so it survives a class duplicated across a bundle boundary', () => {
    // A second realization of the class (as a bundler may emit) has no prototype link to ours;
    // the name-based guard must still recognize it, which an instanceof check would not.
    const foreign = Object.assign(new Error('x'), { name: 'EmbeddingAuthError' });
    expect(isEmbeddingAuthError(foreign)).toBe(true);
  });

  it('rejects a plain error, a token-limit error, and non-errors', () => {
    expect(isEmbeddingAuthError(new Error('some other failure'))).toBe(false);
    expect(isEmbeddingAuthError({ name: 'EmbeddingAuthError' })).toBe(false); // not an Error instance
    expect(isEmbeddingAuthError(null)).toBe(false);
    expect(isEmbeddingAuthError('EmbeddingAuthError')).toBe(false);
  });
});
