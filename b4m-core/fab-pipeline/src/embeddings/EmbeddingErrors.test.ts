import { describe, it, expect } from 'vitest';
import {
  EmbeddingAuthError,
  isEmbeddingAuthError,
  EmbeddingSpaceConflictError,
  isEmbeddingSpaceConflictError,
} from './EmbeddingErrors';

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

describe('EmbeddingSpaceConflictError', () => {
  it('names both the attempted model and every space the file already holds', () => {
    const err = new EmbeddingSpaceConflictError('amazon.titan-embed-text-v2:0', ['text-embedding-3-small']);
    expect(err.attemptedModel).toBe('amazon.titan-embed-text-v2:0');
    expect(err.existingModels).toEqual(['text-embedding-3-small']);
    expect(err.message).toMatch(/amazon\.titan-embed-text-v2:0/);
    expect(err.message).toMatch(/text-embedding-3-small/);
    expect(err).toBeInstanceOf(Error);
  });

  it('lists every existing space when the file already spans more than one', () => {
    const err = new EmbeddingSpaceConflictError('voyage-3', ['text-embedding-3-small', 'amazon.titan-embed-text-v2:0']);
    expect(err.message).toMatch(/text-embedding-3-small, amazon\.titan-embed-text-v2:0/);
  });

  it('copies existingModels so a caller cannot mutate the recorded spaces afterwards', () => {
    const spaces = ['text-embedding-3-small'];
    const err = new EmbeddingSpaceConflictError('voyage-3', spaces);
    spaces.push('amazon.titan-embed-text-v2:0');
    expect(err.existingModels).toEqual(['text-embedding-3-small']);
  });

  it('preserves the underlying cause', () => {
    const original = new Error('resolved by keyless fallback');
    const err = new EmbeddingSpaceConflictError('voyage-3', ['text-embedding-3-small'], { cause: original });
    expect(err.cause).toBe(original);
  });
});

describe('isEmbeddingSpaceConflictError', () => {
  it('identifies an EmbeddingSpaceConflictError', () => {
    expect(isEmbeddingSpaceConflictError(new EmbeddingSpaceConflictError('voyage-3', ['ada']))).toBe(true);
  });

  it('identifies by name so it survives a class duplicated across a bundle boundary', () => {
    // Thrown in fab-pipeline, caught in apps/client: the same reason EmbeddingAuthError is
    // name-detected rather than instanceof-checked.
    const foreign = Object.assign(new Error('x'), { name: 'EmbeddingSpaceConflictError' });
    expect(isEmbeddingSpaceConflictError(foreign)).toBe(true);
  });

  it('does not confuse the two embedding error kinds', () => {
    expect(isEmbeddingSpaceConflictError(new EmbeddingAuthError('openai', 'x'))).toBe(false);
    expect(isEmbeddingAuthError(new EmbeddingSpaceConflictError('voyage-3', ['ada']))).toBe(false);
  });

  it('rejects a plain error and non-errors', () => {
    expect(isEmbeddingSpaceConflictError(new Error('some other failure'))).toBe(false);
    expect(isEmbeddingSpaceConflictError({ name: 'EmbeddingSpaceConflictError' })).toBe(false);
    expect(isEmbeddingSpaceConflictError(null)).toBe(false);
  });
});
