import { describe, expect, it } from 'vitest';
import { bucketsToRoll } from './buckets';

const at = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00.000Z`);
const iso = (dates: Date[]) => dates.map(date => date.toISOString().slice(11, 16));

describe('bucketsToRoll', () => {
  it('includes a bucket exactly 7 minutes after its start', () => {
    expect(iso(bucketsToRoll(at('10:12'), at('09:55')))).toEqual(['10:00', '10:05']);
  });

  it('excludes a bucket that has not settled yet', () => {
    expect(iso(bucketsToRoll(at('10:11'), at('09:55')))).toEqual(['10:00']);
  });

  it('returns only the newest closed bucket when nothing was rolled yet', () => {
    expect(iso(bucketsToRoll(at('10:12'), null))).toEqual(['10:05']);
  });

  it('caps a long gap to the newest 24 buckets', () => {
    const buckets = bucketsToRoll(at('13:12'), at('10:00'));
    expect(buckets).toHaveLength(24);
    expect(iso(buckets).at(0)).toBe('11:10');
    expect(iso(buckets).at(-1)).toBe('13:05');
  });

  it('returns nothing when the newest closed bucket is already rolled', () => {
    expect(bucketsToRoll(at('10:12'), at('10:05'))).toEqual([]);
  });
});
