import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { modelSwitchCredits } from './modelSwitchCost';

const PER_MTOK = 1 / 1_000_000;
const opus: ChatModelOption = {
  id: 'claude-opus-5-5',
  name: 'Opus 5.5',
  backend: 'anthropic',
  pricing: { 200_000: { input: 5 * PER_MTOK, output: 25 * PER_MTOK, cache_write: 6.25 * PER_MTOK } },
};

describe('modelSwitchCredits', () => {
  it('prices the context as a cache write on direct Anthropic', () => {
    expect(modelSwitchCredits(opus, 100_000)).toBe(Math.ceil(0.625 * CREDITS_PER_USD_COST));
  });

  it('prices the context as plain input elsewhere', () => {
    expect(modelSwitchCredits({ ...opus, backend: 'bedrock' }, 100_000)).toBe(Math.ceil(0.5 * CREDITS_PER_USD_COST));
  });

  it('says nothing for an empty chat, an unpriced model or an unknown backend', () => {
    expect(modelSwitchCredits(opus, 0)).toBeNull();
    expect(modelSwitchCredits({ ...opus, pricing: undefined }, 100_000)).toBeNull();
    expect(modelSwitchCredits({ ...opus, backend: 'local-mlx' }, 100_000)).toBeNull();
    expect(
      modelSwitchCredits({ ...opus, pricing: { 200_000: { input: 0, output: 0, cache_write: 0 } } }, 10)
    ).toBeNull();
  });
});
