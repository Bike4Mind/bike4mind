import { describe, it, expect } from 'vitest';
import { settleToolCallCredits } from './settleToolCredits';

const sum = (fcs: { creditsUsed?: number }[]) => fcs.reduce((acc, fc) => acc + (fc.creditsUsed ?? 0), 0);

describe('settleToolCallCredits', () => {
  it('stamps a single call with its reserved charge', () => {
    const calls = [{ name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [120]]]));
    expect(settled).toEqual([{ name: 'music_generation', creditsUsed: 120 }]);
  });

  it('settles two music_generation calls as the sum of both, not 2x the later cost', () => {
    // The bug this locks: a name-keyed single value stamped both calls with 200 -> 400.
    const calls = [{ name: 'music_generation' }, { name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [100, 200]]]));
    expect(settled.map(fc => fc.creditsUsed)).toEqual([100, 200]);
    expect(sum(settled)).toBe(300);
  });

  it('keeps each tool independent when several tools fire in one turn', () => {
    const calls = [{ name: 'image_generation' }, { name: 'music_generation' }, { name: 'music_generation' }];
    const map = new Map([
      ['image_generation', [400]],
      ['music_generation', [100, 250]],
    ]);
    expect(settleToolCallCredits(calls, map).map(fc => fc.creditsUsed)).toEqual([400, 100, 250]);
  });

  it('bills only the delivered call when an earlier same-tool call reserved nothing', () => {
    // A failed music_generation returns before onFinish, so only one charge is queued
    // for two calls. Attribution shifts to the first entry, but the total is unchanged.
    const calls = [{ name: 'music_generation' }, { name: 'music_generation' }];
    const settled = settleToolCallCredits(calls, new Map([['music_generation', [180]]]));
    expect(sum(settled)).toBe(180);
  });

  it('leaves calls with no reservation untouched', () => {
    const calls = [{ name: 'web_search' }, { name: 'music_generation', creditsUsed: 7 }];
    const settled = settleToolCallCredits(calls, new Map());
    expect(settled).toEqual([{ name: 'web_search' }, { name: 'music_generation', creditsUsed: 7 }]);
  });

  it('does not mutate the shared credits map', () => {
    const map = new Map([['music_generation', [100, 200]]]);
    settleToolCallCredits([{ name: 'music_generation' }, { name: 'music_generation' }], map);
    expect(map.get('music_generation')).toEqual([100, 200]);
  });
});
