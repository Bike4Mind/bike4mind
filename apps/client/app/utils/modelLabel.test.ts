import { describe, it, expect } from 'vitest';
import { isSubstituted, modelKey, modelLabel } from './modelLabel';

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

  it('treats a provider-only difference as a substitution', () => {
    const providerOnly = { ...plain, executedProvider: 'openai', executedModel: 'opus' };
    expect(isSubstituted(providerOnly)).toBe(true);
    expect(modelLabel(providerOnly)).toBe('bedrock / opus (ran: openai / opus)');
  });
});

describe('modelKey', () => {
  it('differs between a plain row and a substituted row of the same requested model', () => {
    expect(modelKey(plain)).not.toBe(modelKey(swapped));
  });

  it('differs when only the executed provider differs', () => {
    const sameModel = { ...plain, executedProvider: 'bedrock', executedModel: 'opus' };
    const otherProvider = { ...plain, executedProvider: 'openai', executedModel: 'opus' };
    expect(modelKey(otherProvider)).not.toBe(modelKey(sameModel));
  });
});
