// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import { creditsForUsd, isHostedFirecrawl } from './billedWebTools';

describe('creditsForUsd', () => {
  it('rounds the provider cost times the platform rate up', () => {
    expect(creditsForUsd(0.015)).toBe(Math.ceil(0.015 * CREDITS_PER_USD_COST));
    expect(creditsForUsd(0.002)).toBe(Math.ceil(0.002 * CREDITS_PER_USD_COST));
  });

  it('charges at least one credit for any positive cost', () => {
    expect(creditsForUsd(Number.MIN_VALUE)).toBe(1);
  });

  it('treats a zero cost as free, not as the one-credit floor', () => {
    expect(creditsForUsd(0)).toBe(0);
  });
});

describe('isHostedFirecrawl', () => {
  it.each([
    ['a key and no url', { apiKey: 'k' }, true],
    ['a key and the hosted url', { apiKey: 'k', apiUrl: 'https://api.firecrawl.dev' }, true],
    ['a key and a self-hosted url', { apiKey: 'k', apiUrl: 'http://firecrawl:3002' }, false],
    ['a keyless self-hosted url', { apiUrl: 'http://firecrawl:3002' }, false],
    ['nothing configured (direct fetch)', {}, false],
    ['a key and an unparseable url', { apiKey: 'k', apiUrl: 'not a url' }, false],
  ])('%s', (_label, config, expected) => {
    expect(isHostedFirecrawl(config)).toBe(expected);
  });
});
