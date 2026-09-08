import { Logger } from '@bike4mind/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingModelProvider } from './EmbeddingService';
import {
  __resetEmbeddingRateLimitReporterForTests,
  getLastObservedEmbeddingRateLimit,
  recordEmbeddingRateLimitHeaders,
} from './embeddingRateLimitReporter';

const MODEL = 'text-embedding-ada-002';
const OPENAI = EmbeddingModelProvider.OPENAI;
const ACCOUNT = 'org-platform';

const headers = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'x-ratelimit-limit-tokens': '1000000',
  'x-ratelimit-limit-requests': '10000',
  'x-ratelimit-remaining-tokens': '900000',
  'x-ratelimit-remaining-requests': '9000',
  'x-ratelimit-reset-tokens': '6ms',
  'x-ratelimit-reset-requests': '6ms',
  ...overrides,
});

describe('recordEmbeddingRateLimitHeaders', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetEmbeddingRateLimitReporterForTests();
    // Restore before re-spying: spying an already-spied method stacks wrappers, and the recorded
    // calls would otherwise carry over and make every assertion here order-dependent.
    vi.restoreAllMocks();
    info = vi.spyOn(Logger.globalInstance, 'info').mockImplementation(() => {});
    warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.globalInstance, 'debug').mockImplementation(() => {});
  });

  it('reports the ceiling on the first sighting in the process', () => {
    const observation = recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());

    expect(observation?.snapshot.limitTokens).toBe(1_000_000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('ceiling measured');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent while the ceiling is unchanged, however many calls arrive', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());
    info.mockClear();

    for (let i = 0; i < 50; i++) recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the ceiling changes, naming both the old and the new figure', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());

    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers({ 'x-ratelimit-limit-tokens': '5000000' }));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('ceiling CHANGED');
    expect(message).toContain('1000000 tokens/min');
    expect(message).toContain('5000000 tokens/min');
    expect(warn.mock.calls[0][1]).toMatchObject({ previousLimitTokens: 1_000_000, limitTokens: 5_000_000 });
  });

  it('tracks each provider+model independently', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());
    recordEmbeddingRateLimitHeaders(
      OPENAI,
      'text-embedding-3-small',
      ACCOUNT,
      headers({ 'x-ratelimit-limit-tokens': '2000' })
    );

    // A different model's ceiling is a different reading, not a change to this one.
    expect(warn).not.toHaveBeenCalled();
    expect(getLastObservedEmbeddingRateLimit(OPENAI, MODEL, ACCOUNT)?.snapshot.limitTokens).toBe(1_000_000);
    expect(getLastObservedEmbeddingRateLimit(OPENAI, 'text-embedding-3-small', ACCOUNT)?.snapshot.limitTokens).toBe(
      2_000
    );
  });

  it('keeps two provider accounts as two readings rather than one that flaps between them', () => {
    // The credential is resolved per user, so one process can serve a personal key and the
    // platform key against the same model. Alternating between them is two accounts, not a change.
    const personal = headers({ 'x-ratelimit-limit-tokens': '150000' });

    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, 'org-personal', personal);
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, 'org-personal', personal);

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(2);
    expect(getLastObservedEmbeddingRateLimit(OPENAI, MODEL, ACCOUNT)?.snapshot.limitTokens).toBe(1_000_000);
    expect(getLastObservedEmbeddingRateLimit(OPENAI, MODEL, 'org-personal')?.snapshot.limitTokens).toBe(150_000);
  });

  it('names the account on every reported line, so no figure is attributable to the wrong one', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, 'org-personal', headers());
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, 'org-personal', headers({ 'x-ratelimit-limit-tokens': '5000000' }));

    expect(info.mock.calls[0][0]).toContain('(account org-personal)');
    expect(info.mock.calls[0][1]).toMatchObject({ account: 'org-personal' });
    expect(warn.mock.calls[0][0]).toContain('(account org-personal)');
    // The old copy blamed a key rotation, which is now a different account and so a fresh sighting.
    expect(warn.mock.calls[0][0]).not.toContain('rotation');
  });

  it('warns once per interval while a window is nearly exhausted, not once per call', () => {
    const starved = headers({ 'x-ratelimit-remaining-tokens': '1000' }); // 0.1% of the ceiling
    const start = 1_000_000;

    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, starved, start);
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, starved, start + 1_000);
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, starved, start + 30_000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('tokens window');

    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, starved, start + 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not mistake a healthy window for pressure', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and reports nothing when the provider sent no usable ceiling', () => {
    expect(recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, {})).toBeNull();
    expect(getLastObservedEmbeddingRateLimit(OPENAI, MODEL, ACCOUNT)).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a zero ceiling as unusable rather than dividing by it', () => {
    const observation = recordEmbeddingRateLimitHeaders(
      OPENAI,
      MODEL,
      ACCOUNT,
      headers({ 'x-ratelimit-limit-tokens': '0', 'x-ratelimit-remaining-tokens': '0' })
    );

    // limitRequests is still usable, so this is a reading - but the tokens dimension must not
    // produce a NaN or Infinity ratio and warn about pressure that cannot be computed.
    expect(observation?.snapshot.limitTokens).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a native Headers object as readily as a plain record', () => {
    const observation = recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, new Headers(headers()));
    expect(observation?.snapshot.limitTokens).toBe(1_000_000);
  });

  it('treats a dimension the provider stopped reporting as a change, not as unchanged', () => {
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, headers());

    const withoutTokenCeiling = headers();
    delete withoutTokenCeiling['x-ratelimit-limit-tokens'];
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, withoutTokenCeiling);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('now unreported tokens/min');
  });

  it('never throws, so a reporting fault cannot fail the embedding it rode in on', () => {
    const exploding = {
      get() {
        throw new Error('header access blew up');
      },
    };

    expect(() => recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, exploding)).not.toThrow();
    expect(recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, exploding)).toBeNull();
  });

  it('makes the first reporting fault loud, then quiets down instead of flooding the log', () => {
    const exploding = {
      get() {
        throw new Error('header access blew up');
      },
    };

    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, exploding);
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, exploding);
    recordEmbeddingRateLimitHeaders(OPENAI, MODEL, ACCOUNT, exploding);

    // Silence from a broken reporter reads exactly like a steady ceiling, so the first fault has
    // to reach a default log level; the rest would only drown a bulk re-index.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('failed to record rate-limit headers');
  });
});
