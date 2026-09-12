import { describe, it, expect } from 'vitest';
import { helpEmbeddingsRequired } from '../embeddingsConfig';

describe('helpEmbeddingsRequired', () => {
  it('defaults to required when the flag is unset or blank', () => {
    expect(helpEmbeddingsRequired({})).toBe(true);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: '' })).toBe(true);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: '   ' })).toBe(true);
  });

  it('opts out only on an explicit false', () => {
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: 'false' })).toBe(false);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: 'FALSE' })).toBe(false);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: ' false ' })).toBe(false);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: '0' })).toBe(false);
  });

  it('treats every other value as required, so a typo fails the deploy loudly', () => {
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: 'true' })).toBe(true);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: 'no' })).toBe(true);
    expect(helpEmbeddingsRequired({ HELP_EMBEDDINGS_REQUIRED: 'flase' })).toBe(true);
  });
});
