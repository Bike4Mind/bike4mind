import { describe, expect, it } from 'vitest';
import { withRetry } from '@bike4mind/common';
import { countProviderAttempts, createProviderCallStats, recordAwsProviderCall } from './providerCalls';

const transient = () => Object.assign(new Error('reset'), { code: 'ECONNRESET' });

describe('countProviderAttempts', () => {
  it('counts each try withRetry makes, and a new request restarts the count', async () => {
    const stats = createProviderCallStats('openai');
    let calls = 0;
    await withRetry(
      countProviderAttempts(stats, async () => {
        if (++calls < 3) throw transient();
        return 'ok';
      }),
      { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 }
    );
    expect(stats).toEqual({ provider: 'openai', requests: 1, attempts: 3 });

    await withRetry(
      countProviderAttempts(stats, async () => 'ok'),
      { maxRetries: 3 }
    );
    expect(stats).toMatchObject({ requests: 2, attempts: 1 });
  });

  it('keeps the count when every try fails, where there is no result to read', async () => {
    const stats = createProviderCallStats();
    await expect(
      withRetry(
        countProviderAttempts(stats, async () => {
          throw transient();
        }),
        { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 }
      )
    ).rejects.toThrow('reset');
    expect(stats).toEqual({ requests: 1, attempts: 3 });
  });

  it('passes the call through untouched with no tracker', () => {
    const call = async () => 'ok';
    expect(countProviderAttempts(undefined, call)).toBe(call);
  });
});

describe('recordAwsProviderCall', () => {
  it("reads the SDK's own attempt count from a response or an error", () => {
    const stats = createProviderCallStats();
    recordAwsProviderCall(stats, { $metadata: { attempts: 1 } });
    recordAwsProviderCall(stats, Object.assign(new Error('throttled'), { $metadata: { attempts: 6 } }));
    expect(stats).toEqual({ requests: 2, attempts: 6 });
  });
});
