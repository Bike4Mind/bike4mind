import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './mapConcurrent';

describe('mapConcurrent', () => {
  it('never runs more than the limit at once and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 200 }, (_, i) => i);
    const results = await mapConcurrent(items, 8, async item => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, item % 3));
      inFlight--;
      return item * 2;
    });
    expect(peak).toBe(8);
    expect(results).toEqual(items.map(item => item * 2));
  });

  it('handles fewer items than the limit and no items', async () => {
    expect(await mapConcurrent([1, 2], 64, async item => item + 1)).toEqual([2, 3]);
    expect(await mapConcurrent([], 64, async () => 1)).toEqual([]);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(mapConcurrent([1], 0, async item => item)).rejects.toThrow(RangeError);
  });
});
