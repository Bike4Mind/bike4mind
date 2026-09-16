import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ILatticeModel } from '@bike4mind/common';
import { useLatticeChartData } from './useLatticeChartData';

/** Entity attributes are persisted unvalidated off req.body, so `category` is attacker-chosen. */
function modelWith(category: string): ILatticeModel {
  return {
    data: {
      entities: [
        {
          id: 'e1',
          type: 'line',
          attributes: [
            { key: 'period', value: 'Q1 2026' },
            { key: 'category', value: category },
            { key: 'value', value: 42 },
          ],
        },
      ],
    },
  } as unknown as ILatticeModel;
}

describe('useLatticeChartData dynamic category keys', () => {
  it('lands the series value for an ordinary category', () => {
    const { result } = renderHook(() => useLatticeChartData(modelWith('Revenue')));

    expect(result.current.chartConfig?.config.yAxis).toEqual(['Revenue']);
    expect(result.current.chartConfig?.data[0]?.['Revenue']).toBe(42);
  });

  // The one discriminating key: `constructor`/`toString` land fine on a plain literal as
  // own-property shadows, but a `__proto__` write hits the Object.prototype setter and
  // silently no-ops - the series stays listed in yAxis while its data never arrives, so the
  // chart renders a legend entry with no line and no error anywhere.
  it('lands the series value for a category of __proto__', () => {
    const { result } = renderHook(() => useLatticeChartData(modelWith('__proto__')));

    const dataPoint = result.current.chartConfig?.data[0];
    expect(result.current.chartConfig?.config.yAxis).toEqual(['__proto__']);
    expect(Object.keys(dataPoint ?? {})).toContain('__proto__');
    expect(dataPoint?.['__proto__']).toBe(42);
  });
});
