import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rateLimit';

describe('TokenBucket', () => {
  it('lets a burst through, then refills at its rate up to its capacity', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    expect(bucket.retryAfterSeconds()).toBe(1);
    now = 500;
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    now = 60_000;
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });

  it('does not drain when the clock steps backwards', () => {
    let now = 3_600_000;
    const bucket = new TokenBucket(2, 1, () => now);
    expect(bucket.take()).toBe(true);
    now = 0;
    expect(bucket.take()).toBe(true);
    now = 1_000;
    expect(bucket.take()).toBe(true);
  });
});
