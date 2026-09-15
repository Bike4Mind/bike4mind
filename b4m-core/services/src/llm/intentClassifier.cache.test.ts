import { describe, expect, it } from 'vitest';
import { IntentClassifierCache, hashCacheKey, normalizeMessage } from './intentClassifier.cache';

describe('normalizeMessage', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizeMessage('  Hello   World\n\n')).toBe('hello world');
  });
});

describe('hashCacheKey', () => {
  it('namespaces by userId', () => {
    expect(hashCacheKey({ userId: 'alice', message: 'q' })).not.toBe(hashCacheKey({ userId: 'bob', message: 'q' }));
  });

  it('matches normalized variants', () => {
    expect(hashCacheKey({ userId: 'alice', message: 'Hello' })).toBe(
      hashCacheKey({ userId: 'alice', message: 'hello' })
    );
    expect(hashCacheKey({ userId: 'alice', message: '  hello  ' })).toBe(
      hashCacheKey({ userId: 'alice', message: 'hello' })
    );
  });

  it('changes when prompt-context flags differ', () => {
    const base = { userId: 'alice', message: 'analyze this' };
    expect(hashCacheKey(base)).not.toBe(hashCacheKey({ ...base, hasFileAttachments: true }));
    expect(hashCacheKey(base)).not.toBe(hashCacheKey({ ...base, hasAgentMention: true }));
    expect(hashCacheKey({ ...base, hasFileAttachments: true })).not.toBe(
      hashCacheKey({ ...base, hasFileAttachments: true, hasAgentMention: true })
    );
  });

  it('treats omitted and false flags as the same slot', () => {
    const omitted = { userId: 'alice', message: 'q' };
    const explicitlyFalse = { userId: 'alice', message: 'q', hasFileAttachments: false, hasAgentMention: false };
    expect(hashCacheKey(omitted)).toBe(hashCacheKey(explicitlyFalse));
  });
});

describe('IntentClassifierCache', () => {
  it('returns undefined on miss', () => {
    const cache = new IntentClassifierCache<string>();
    expect(cache.get({ userId: 'u', message: 'q' })).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = new IntentClassifierCache<string>();
    cache.set({ userId: 'u', message: 'q' }, 'v');
    expect(cache.get({ userId: 'u', message: 'q' })).toBe('v');
  });

  it('expires entries past TTL', () => {
    let nowMs = 1000;
    const cache = new IntentClassifierCache<string>({ ttlMs: 100, now: () => nowMs });
    cache.set({ userId: 'u', message: 'q' }, 'v');
    nowMs = 1099;
    expect(cache.get({ userId: 'u', message: 'q' })).toBe('v');
    nowMs = 1101;
    expect(cache.get({ userId: 'u', message: 'q' })).toBeUndefined();
  });

  it('evicts the least-recently-used entry when over capacity', () => {
    const cache = new IntentClassifierCache<string>({ maxEntries: 2 });
    cache.set({ userId: 'u', message: 'a' }, '1');
    cache.set({ userId: 'u', message: 'b' }, '2');
    // Touch `a` so it becomes most-recently-used; `b` is now the LRU.
    expect(cache.get({ userId: 'u', message: 'a' })).toBe('1');
    cache.set({ userId: 'u', message: 'c' }, '3');
    expect(cache.get({ userId: 'u', message: 'b' })).toBeUndefined();
    expect(cache.get({ userId: 'u', message: 'a' })).toBe('1');
    expect(cache.get({ userId: 'u', message: 'c' })).toBe('3');
  });

  it('isolates entries by userId', () => {
    const cache = new IntentClassifierCache<string>();
    cache.set({ userId: 'alice', message: 'q' }, 'A');
    cache.set({ userId: 'bob', message: 'q' }, 'B');
    expect(cache.get({ userId: 'alice', message: 'q' })).toBe('A');
    expect(cache.get({ userId: 'bob', message: 'q' })).toBe('B');
  });

  it('isolates same-message entries by hasFileAttachments flag', () => {
    const cache = new IntentClassifierCache<string>();
    cache.set({ userId: 'u', message: 'analyze this' }, 'no-files');
    cache.set({ userId: 'u', message: 'analyze this', hasFileAttachments: true }, 'with-files');
    expect(cache.get({ userId: 'u', message: 'analyze this' })).toBe('no-files');
    expect(cache.get({ userId: 'u', message: 'analyze this', hasFileAttachments: true })).toBe('with-files');
  });

  it('isolates same-message entries by hasAgentMention flag', () => {
    const cache = new IntentClassifierCache<string>();
    cache.set({ userId: 'u', message: 'analyze this' }, 'no-agent');
    cache.set({ userId: 'u', message: 'analyze this', hasAgentMention: true }, 'with-agent');
    expect(cache.get({ userId: 'u', message: 'analyze this' })).toBe('no-agent');
    expect(cache.get({ userId: 'u', message: 'analyze this', hasAgentMention: true })).toBe('with-agent');
  });
});
