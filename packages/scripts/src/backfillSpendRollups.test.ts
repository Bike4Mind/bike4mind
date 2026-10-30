import { describe, it, expect, vi } from 'vitest';
import { SPEND_BUCKET_MS } from '@bike4mind/common';
import { backfillSpendRollups } from './backfillSpendRollups';

const makeRepo = () => ({ rollupBucket: vi.fn().mockResolvedValue({ docs: 0 }) });

describe('backfillSpendRollups', () => {
  const from = new Date('2026-06-05T10:00:00.000Z');
  const to = new Date('2026-06-05T11:00:00.000Z');

  it('rolls up every bucket in the range in ascending order and returns the count', async () => {
    const repo = makeRepo();

    const count = await backfillSpendRollups(repo, from, to);

    expect(count).toBe(12);
    const starts = repo.rollupBucket.mock.calls.map(([bucketStart]: [Date]) => bucketStart.getTime());
    expect(starts[0]).toBe(from.getTime());
    expect(starts[11]).toBe(to.getTime() - SPEND_BUCKET_MS);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('floors unaligned bounds and excludes the bucket that contains `to`', async () => {
    const repo = makeRepo();

    const count = await backfillSpendRollups(
      repo,
      new Date('2026-06-05T10:02:30.000Z'),
      new Date('2026-06-05T10:17:00.000Z')
    );

    expect(count).toBe(3);
    expect(repo.rollupBucket.mock.calls[2][0].toISOString()).toBe('2026-06-05T10:10:00.000Z');
  });

  it('returns 0 when the range holds no whole bucket', async () => {
    const repo = makeRepo();

    expect(await backfillSpendRollups(repo, from, new Date(from.getTime() + 1000))).toBe(0);
    expect(repo.rollupBucket).not.toHaveBeenCalled();
  });

  it('reports progress once per day of buckets and at the end', async () => {
    const repo = makeRepo();
    const onProgress = vi.fn();
    const twoDaysAndABit = new Date(from.getTime() + 577 * SPEND_BUCKET_MS);

    await backfillSpendRollups(repo, from, twoDaysAndABit, onProgress);

    expect(onProgress.mock.calls).toEqual([
      [288, 577],
      [576, 577],
      [577, 577],
    ]);
  });

  it('stops on the first failing bucket', async () => {
    const repo = makeRepo();
    repo.rollupBucket.mockRejectedValueOnce(new Error('boom'));

    await expect(backfillSpendRollups(repo, from, to)).rejects.toThrow('boom');
    expect(repo.rollupBucket).toHaveBeenCalledTimes(1);
  });
});
