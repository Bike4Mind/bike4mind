import { describe, expect, it } from 'vitest';
import { buildCreditCycles, seatChangesFrom } from './getAdminSubscriptionHistory';

const at = (day: number) => new Date(Date.UTC(2026, 0, day));

describe('buildCreditCycles', () => {
  it('closes each cycle at the next grant and runs the last to the window end', () => {
    const used = new Map([
      [at(1).getTime(), 400],
      [at(31).getTime(), 120],
    ]);
    expect(
      buildCreditCycles(
        [
          { at: at(1), credits: 1000 },
          { at: at(31), credits: 1000 },
        ],
        at(45),
        used,
        true
      )
    ).toEqual([
      { start: at(1).toISOString(), end: at(31).toISOString(), granted: 1000, used: 400, current: false },
      { start: at(31).toISOString(), end: at(45).toISOString(), granted: 1000, used: 120, current: true },
    ]);
  });

  it('merges grants written in the same millisecond and reads missing usage as zero', () => {
    const cycles = buildCreditCycles(
      [
        { at: at(1), credits: 500 },
        { at: at(1), credits: 250 },
      ],
      at(10),
      new Map(),
      false
    );
    expect(cycles).toEqual([
      { start: at(1).toISOString(), end: at(10).toISOString(), granted: 750, used: 0, current: false },
    ]);
  });

  it('returns no cycles without grants', () => {
    expect(buildCreditCycles([], at(10), new Map(), true)).toEqual([]);
  });
});

describe('seatChangesFrom', () => {
  it('keeps only the events that changed the quantity', () => {
    expect(
      seatChangesFrom([
        { at: at(1), quantity: 3 },
        { at: at(2), quantity: 3 },
        { at: at(5), quantity: 5 },
        { at: at(9), quantity: 3 },
      ])
    ).toEqual([
      { at: at(1).toISOString(), quantity: 3 },
      { at: at(5).toISOString(), quantity: 5 },
      { at: at(9).toISOString(), quantity: 3 },
    ]);
  });
});
