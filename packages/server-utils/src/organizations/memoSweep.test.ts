import { describe, it, expect } from 'vitest';
import { MEMO_SWEEP_INTERVAL_MS, MEMO_SWEEP_SIZE, sweepExpiredMemo } from './memoSweep';

const NOW = 1_000_000;

function fill(map: Map<string, number>, count: number, expiresAt: number, prefix: string): void {
  for (let i = 0; i < count; i++) map.set(`${prefix}${i}`, expiresAt);
}

describe('sweepExpiredMemo', () => {
  it('leaves a map below the size threshold untouched', () => {
    const map = new Map<string, number>();
    fill(map, MEMO_SWEEP_SIZE - 1, NOW - 1, 'old');
    sweepExpiredMemo(map, NOW, v => v);
    expect(map.size).toBe(MEMO_SWEEP_SIZE - 1);
  });

  it('drops expired entries, including one expiring exactly now, and keeps live ones', () => {
    const map = new Map<string, number>();
    fill(map, 600, NOW - 1, 'old');
    fill(map, 399, NOW + 1, 'live');
    map.set('edge', NOW);
    sweepExpiredMemo(map, NOW, v => v);
    expect(map.size).toBe(399);
    expect([...map.keys()].every(k => k.startsWith('live'))).toBe(true);
  });

  it('does not rescan the same map until the interval has passed', () => {
    const map = new Map<string, number>();
    fill(map, MEMO_SWEEP_SIZE, NOW + 10, 'live');
    sweepExpiredMemo(map, NOW, v => v);
    expect(map.size).toBe(MEMO_SWEEP_SIZE);

    const later = NOW + 20;
    sweepExpiredMemo(map, later, v => v);
    expect(map.size).toBe(MEMO_SWEEP_SIZE);

    sweepExpiredMemo(map, NOW + MEMO_SWEEP_INTERVAL_MS, v => v);
    expect(map.size).toBe(0);
  });

  it('reads expiry through the accessor for object values', () => {
    const map = new Map<string, { expiresAt: number }>();
    for (let i = 0; i < MEMO_SWEEP_SIZE; i++) map.set(`k${i}`, { expiresAt: i % 2 ? NOW + 1 : NOW - 1 });
    sweepExpiredMemo(map, NOW, v => v.expiresAt);
    expect(map.size).toBe(MEMO_SWEEP_SIZE / 2);
  });
});
