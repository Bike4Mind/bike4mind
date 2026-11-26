import { describe, expect, it } from 'vitest';
import {
  barCodeForState,
  formatBasisPoints,
  formatUptimePercent,
  floorUptimeFraction,
  stateForBarCode,
  uptimeFraction,
  uptimeToBasisPoints,
} from './uptimeDisplay';

describe('uptime display', () => {
  it('floors to two decimals and never rounds up', () => {
    expect(formatUptimePercent(0.99953)).toBe('99.95%');
    expect(formatUptimePercent(0.99999)).toBe('99.99%');
    expect(formatUptimePercent(0.9995)).toBe('99.95%');
    expect(formatUptimePercent(0.5)).toBe('50.00%');
    expect(formatUptimePercent(0.0001)).toBe('0.01%');
    expect(formatUptimePercent(0)).toBe('0.00%');
  });

  it('never rounds a value that is not on a whole basis point up', () => {
    expect(formatUptimePercent(0.98999996)).toBe('98.99%');
    expect(uptimeToBasisPoints(0.98999996)).toBe(9_899);
    expect(formatUptimePercent(0.999949999)).toBe('99.99%');
    expect(formatUptimePercent(0.00019999)).toBe('0.01%');
    for (let bp = 0; bp < 10_000; bp++) expect(uptimeToBasisPoints(bp / 10_000)).toBe(bp);
  });

  it('shows 100% only for an exact 1', () => {
    expect(formatUptimePercent(1)).toBe('100%');
    expect(formatUptimePercent(0.999999)).toBe('99.99%');
    expect(uptimeToBasisPoints(0.999999)).toBe(9_999);
  });

  it('shows No data for null', () => {
    expect(formatUptimePercent(null)).toBe('No data');
    expect(formatBasisPoints(null)).toBe('No data');
  });

  it('formats basis points', () => {
    expect(formatBasisPoints(9_995)).toBe('99.95%');
    expect(formatBasisPoints(10_000)).toBe('100%');
    expect(formatBasisPoints(9_999)).toBe('99.99%');
    expect(formatBasisPoints(0)).toBe('0.00%');
  });

  it('computes a floored fraction and reaches 1 only with zero downtime', () => {
    expect(uptimeFraction(0, 86_400)).toBe(1);
    expect(uptimeFraction(0.001, 86_400)).toBe(0.99999);
    expect(uptimeFraction(86.4, 86_400)).toBe(0.999);
    expect(uptimeFraction(86_400, 86_400)).toBe(0);
    expect(uptimeFraction(10, 0)).toBeNull();
  });

  it('has no fraction for non-finite or negative input', () => {
    expect(uptimeFraction(Number.NaN, 86_400)).toBeNull();
    expect(uptimeFraction(1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(uptimeFraction(Number.POSITIVE_INFINITY, 86_400)).toBeNull();
    expect(uptimeFraction(-1, 86_400)).toBeNull();
  });

  it('maps bar codes to states and back', () => {
    expect(barCodeForState('operational')).toBe('o');
    expect(barCodeForState('major_outage')).toBe('m');
    expect(barCodeForState('unknown')).toBe('n');
    expect(stateForBarCode('p')).toBe('partial_outage');
    expect(stateForBarCode('x')).toBeNull();
    expect(stateForBarCode('n')).toBeNull();
  });
});

describe('public fraction grid', () => {
  it('preserves every canonical grid point, including repeated projection', () => {
    for (let units = 0; units <= 100_000; units++) {
      const value = units / 100_000;
      if (floorUptimeFraction(value) !== value || floorUptimeFraction(floorUptimeFraction(value)) !== value) {
        throw new Error(`Grid point changed: ${units}`);
      }
    }
  });

  it('floors the neighboring IEEE-754 values without rounding up', () => {
    const bits = new DataView(new ArrayBuffer(8));
    const adjacent = (value: number, direction: bigint) => {
      bits.setFloat64(0, value);
      bits.setBigUint64(0, bits.getBigUint64(0) + direction);
      return bits.getFloat64(0);
    };
    for (const units of [1, 3, 10, 30, 100, 12345, 50000, 99999]) {
      const value = units / 100_000;
      expect(floorUptimeFraction(adjacent(value, -1n))).toBe((units - 1) / 100_000);
      expect(floorUptimeFraction(adjacent(value, 1n))).toBe(value);
    }
    expect(floorUptimeFraction(adjacent(1, -1n))).toBe(0.99999);
    expect(floorUptimeFraction(1)).toBe(1);
  });

  it('retains finite clamping and rejects non-finite values', () => {
    expect(floorUptimeFraction(-0.1)).toBe(0);
    expect(floorUptimeFraction(1.1)).toBe(1);
    for (const value of [null, NaN, Infinity, -Infinity]) expect(floorUptimeFraction(value)).toBeNull();
    expect(floorUptimeFraction(0.1234567)).toBe(0.12345);
  });
});
