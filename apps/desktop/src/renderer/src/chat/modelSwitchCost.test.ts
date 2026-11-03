import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  cacheExpiryNoticeCredits,
  CACHE_NOTICE_MIN_CREDITS,
  modelSwitchCredits,
  promptCacheExpiresAt,
  roundNoticeCredits,
} from './modelSwitchCost';

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

  it('prices a 1-hour write at twice input on direct Anthropic only', () => {
    expect(modelSwitchCredits(opus, 100_000, '1h')).toBe(Math.ceil(1 * CREDITS_PER_USD_COST));
    expect(modelSwitchCredits({ ...opus, backend: 'bedrock' }, 100_000, '1h')).toBe(
      Math.ceil(0.5 * CREDITS_PER_USD_COST)
    );
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

describe('cacheExpiryNoticeCredits', () => {
  const stamp = { cachedAt: 1_000_000, ttl: '5m' as const, model: opus.id };
  const base = { expired: true, stamp, model: opus, contextTokens: 100_000, ttl: '5m' as const };

  it('expires 5 minutes or an hour after the stamp', () => {
    expect(promptCacheExpiresAt(stamp)).toBe(1_000_000 + 5 * 60_000);
    expect(promptCacheExpiresAt({ ...stamp, ttl: '1h' })).toBe(1_000_000 + 60 * 60_000);
    expect(promptCacheExpiresAt(undefined)).toBeNull();
  });

  it('prices the re-write at the TTL the next message writes at, rounded', () => {
    expect(cacheExpiryNoticeCredits(base)).toBe(roundNoticeCredits(modelSwitchCredits(opus, 100_000)!));
    expect(cacheExpiryNoticeCredits({ ...base, ttl: '1h' })).toBe(
      roundNoticeCredits(modelSwitchCredits(opus, 100_000, '1h')!)
    );
  });

  it('stays hidden while warm, after a model switch, for a new chat, and under the threshold', () => {
    expect(cacheExpiryNoticeCredits({ ...base, expired: false })).toBeNull();
    expect(cacheExpiryNoticeCredits({ ...base, model: { ...opus, id: 'claude-sonnet-5' } })).toBeNull();
    expect(cacheExpiryNoticeCredits({ ...base, stamp: undefined })).toBeNull();
    const small = Math.floor((CACHE_NOTICE_MIN_CREDITS - 1) / (6.25 * PER_MTOK * CREDITS_PER_USD_COST));
    expect(modelSwitchCredits(opus, small)!).toBeLessThan(CACHE_NOTICE_MIN_CREDITS);
    expect(cacheExpiryNoticeCredits({ ...base, contextTokens: small })).toBeNull();
  });

  it('rounds to tens under 1,000 and hundreds above', () => {
    expect(roundNoticeCredits(734)).toBe(730);
    expect(roundNoticeCredits(4_260)).toBe(4_300);
  });
});
