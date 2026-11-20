import { describe, expect, it } from 'vitest';
import { isIsolatedPoint } from './isolatedPoint';

const rows = (values: Array<number | null>) => values.map(dau => ({ dau }));

describe('isIsolatedPoint', () => {
  it('flags a value between nulls', () => {
    expect(isIsolatedPoint(rows([null, 3, null]), 1, 'dau')).toBe(true);
  });

  it('does not flag a point with a neighbour', () => {
    expect(isIsolatedPoint(rows([1, 3, null]), 1, 'dau')).toBe(false);
    expect(isIsolatedPoint(rows([null, 3, 2]), 1, 'dau')).toBe(false);
  });

  it('treats the first and last rows as having absent neighbours', () => {
    expect(isIsolatedPoint(rows([3, null]), 0, 'dau')).toBe(true);
    expect(isIsolatedPoint(rows([null, 3]), 1, 'dau')).toBe(true);
    expect(isIsolatedPoint(rows([3]), 0, 'dau')).toBe(true);
    expect(isIsolatedPoint(rows([3, 4]), 0, 'dau')).toBe(false);
  });

  it('never flags a null value', () => {
    expect(isIsolatedPoint(rows([null, null, null]), 1, 'dau')).toBe(false);
  });
});
