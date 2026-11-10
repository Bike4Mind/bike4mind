import { describe, it, expect } from 'vitest';
import { modelKey, modelLabel } from './modelLabel';

const plain = { provider: 'bedrock', model: 'opus' };
const swapped = { ...plain, executedProvider: 'openai', executedModel: 'gpt-4o-mini' };

describe('modelLabel', () => {
  it('shows provider / model when nothing was substituted', () => {
    expect(modelLabel(plain)).toBe('bedrock / opus');
    expect(modelLabel({ ...plain, executedProvider: 'bedrock', executedModel: 'opus' })).toBe('bedrock / opus');
  });

  it('adds what ran when the executed pair differs', () => {
    expect(modelLabel(swapped)).toBe('bedrock / opus (ran: openai / gpt-4o-mini)');
  });
});

describe('modelKey', () => {
  it('differs between a plain row and a substituted row of the same requested model', () => {
    expect(modelKey(plain)).not.toBe(modelKey(swapped));
  });
});
