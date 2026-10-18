import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { pickExploreModel, shouldOfferExplore } from './explore';

const option = (id: string, backend = 'anthropic') => ({ id, name: id, backend });

describe('pickExploreModel', () => {
  it('prefers the best Sonnet the deployment offers', () => {
    const available = [
      option(ChatModels.CLAUDE_5_OPUS),
      option(ChatModels.CLAUDE_4_6_SONNET),
      option(ChatModels.CLAUDE_5_SONNET),
    ];
    expect(pickExploreModel(available, ChatModels.CLAUDE_5_OPUS)).toBe(ChatModels.CLAUDE_5_SONNET);
  });

  it("only picks a model on the session model's own backend", () => {
    const available = [
      option(ChatModels.CLAUDE_5_SONNET),
      option(ChatModels.GPT5, 'openai'),
      option(ChatModels.GPT5_MINI, 'openai'),
    ];
    expect(pickExploreModel(available, ChatModels.GPT5)).toBe(ChatModels.GPT5_MINI);
    expect(pickExploreModel(available.slice(0, 2), ChatModels.GPT5)).toBe(ChatModels.GPT5);
  });

  it('falls back to the session model when its backend is unknown', () => {
    expect(pickExploreModel([{ id: 'x', name: 'x' }, option(ChatModels.CLAUDE_5_SONNET)], 'x')).toBe('x');
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

  it('is off for a GPT session when only Claude could explore', () => {
    expect(shouldOfferExplore([...available, option(ChatModels.GPT5, 'openai')], ChatModels.GPT5)).toBe(false);
  });
});
