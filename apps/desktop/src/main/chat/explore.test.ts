import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { pickExploreModel } from './explore';

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
