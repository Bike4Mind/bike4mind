import { describe, it, expect } from 'vitest';
import { capState } from './capState';

const base = { totalCap: null, dailyCap: null, redeemedTotal: 0, redeemedToday: 0 };

describe('capState', () => {
  it.each([
    ['no caps', { ...base, redeemedTotal: 99, redeemedToday: 99 }, null],
    ['under both caps', { ...base, totalCap: 5, dailyCap: 2, redeemedTotal: 4, redeemedToday: 1 }, null],
    ['total reached', { ...base, totalCap: 5, redeemedTotal: 5 }, 'total'],
    ['total exceeded', { ...base, totalCap: 5, redeemedTotal: 6 }, 'total'],
    ['total cap of 0', { ...base, totalCap: 0 }, 'total'],
    ['daily reached', { ...base, totalCap: 5, dailyCap: 1, redeemedTotal: 1, redeemedToday: 1 }, 'daily'],
    ['daily cap of 0', { ...base, dailyCap: 0 }, 'daily'],
    ['total wins over daily', { ...base, totalCap: 1, dailyCap: 1, redeemedTotal: 1, redeemedToday: 1 }, 'total'],
    ['no daily cap never reports daily', { ...base, totalCap: 10, redeemedTotal: 1, redeemedToday: 50 }, null],
  ] as const)('%s', (_name, row, expected) => {
    expect(capState(row)).toBe(expected);
  });
});
