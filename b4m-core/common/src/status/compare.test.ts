import { describe, expect, it } from 'vitest';
import { cmpStr, cmpTime } from './compare';

describe('byte-stable ordering', () => {
  it('orders strings by code unit, not by locale', () => {
    expect(['b', 'B', 'a', 'A', '_', '1'].sort(cmpStr)).toEqual(['1', 'A', 'B', '_', 'a', 'b']);
    expect(['a-b', 'a_b', 'ab', 'a1'].sort(cmpStr)).toEqual(['a-b', 'a1', 'a_b', 'ab']);
    expect(cmpStr('x', 'x')).toBe(0);
  });

  it('orders timestamps by parsed time, whatever the spelling', () => {
    expect(cmpTime('2026-11-23T19:40:07.500Z', '2026-11-23T19:40:07Z')).toBeGreaterThan(0);
    expect(cmpTime('2026-11-23T19:40:07Z', '2026-11-23T19:40:07.000Z')).toBe(0);
    expect(cmpTime('2026-11-23T19:40:07+00:00', '2026-11-23T19:41:00Z')).toBeLessThan(0);
    expect(cmpTime('2026-11-23T20:00:00+05:00', '2026-11-23T16:00:00Z')).toBeLessThan(0);
  });

  it('falls back to the raw strings when a timestamp does not parse', () => {
    expect(cmpTime('', '2026-11-23T19:40:07Z')).toBeLessThan(0);
    expect(cmpTime('b', 'a')).toBeGreaterThan(0);
  });
});
