import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { pickExploreModel, shouldOfferExplore } from './explore';

const option = (id: string) => ({ id, name: id });

describe('pickExploreModel', () => {
  it('prefers the best Sonnet the deployment offers', () => {
    const available = [
      option(ChatModels.CLAUDE_5_OPUS),
      option(ChatModels.CLAUDE_4_6_SONNET),
      option(ChatModels.CLAUDE_5_SONNET),
    ];
    expect(pickExploreModel(available, ChatModels.CLAUDE_5_OPUS)).toBe(ChatModels.CLAUDE_5_SONNET);
  });

  it('falls back to the session model when no Sonnet is offered or the list is unknown', () => {
    expect(pickExploreModel([option('llama3')], 'llama3')).toBe('llama3');
    expect(pickExploreModel([], ChatModels.CLAUDE_5_OPUS)).toBe(ChatModels.CLAUDE_5_OPUS);
  });
});

describe('shouldOfferExplore', () => {
  const available = [
    option(ChatModels.CLAUDE_5_OPUS),
    option(ChatModels.CLAUDE_5_SONNET),
    option(ChatModels.CLAUDE_4_5_SONNET),
    option('claude-haiku-4-5'),
  ];

  it('is off for Opus-class sessions even when a cheaper model exists', () => {
    expect(shouldOfferExplore(available, ChatModels.CLAUDE_5_OPUS)).toBe(false);
    expect(shouldOfferExplore(available, 'some-vendor.claude-opus-9')).toBe(false);
  });

  it('is on for smaller session models', () => {
    expect(shouldOfferExplore(available, 'claude-haiku-4-5')).toBe(true);
    expect(shouldOfferExplore(available, ChatModels.CLAUDE_4_5_SONNET)).toBe(true);
  });

  it('is off when the explore model would be the session model', () => {
    expect(shouldOfferExplore(available, ChatModels.CLAUDE_5_SONNET)).toBe(false);
    expect(shouldOfferExplore([option('llama3')], 'llama3')).toBe(false);
    expect(shouldOfferExplore([], 'llama3')).toBe(false);
  });
});
