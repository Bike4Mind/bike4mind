import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './mapWithConcurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async value => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, value));
      inFlight--;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it('resolves an empty list without running the task', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });

  it('stops starting tasks after the first rejection and surfaces it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async value => {
        started.push(value);
        if (value === 2) throw new Error('boom');
        return value;
      })
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1, 2]);
  });

  it('rejects a non-positive limit', async () => {
    await expect(mapWithConcurrency([1], 0, async value => value)).rejects.toThrow(/positive integer/);
  });
});
