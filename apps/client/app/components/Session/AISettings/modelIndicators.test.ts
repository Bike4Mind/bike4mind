import { describe, expect, it } from 'vitest';
import { formatContextWindow, formatNumber } from './modelIndicators';

describe('formatNumber', () => {
  it('groups thousands with commas', () => {
    expect(formatNumber(1050000)).toBe('1,050,000');
    expect(formatNumber(8192)).toBe('8,192');
    expect(formatNumber(448)).toBe('448');
  });
});

describe('formatContextWindow', () => {
  // These values are caps, so the abbreviation must never read higher than the real limit -
  // that would promise headroom the model does not have. Every case here is a real catalog
  // value; the powers of two are what made rounding unsafe.
  it.each([
    [32768, '32K'], // rounded to 33K before
    [65535, '65K'], // rounded to 66K before
    [65536, '65K'], // rounded to 66K before
    [8192, '8K'],
    [16384, '16K'],
    [131072, '131K'],
    [262144, '262K'],
    [2097152, '2.0M'], // rounded to 2.1M before
    [1050000, '1.0M'], // rounded to 1.1M before
    [1048576, '1.0M'],
  ])('never overstates %i', (size, expected) => {
    expect(formatContextWindow(size)).toBe(expected);

    const shown = expected.endsWith('M')
      ? parseFloat(expected) * 1000000
      : expected.endsWith('K')
        ? parseFloat(expected) * 1000
        : parseFloat(expected);
    expect(shown).toBeLessThanOrEqual(size);
  });

  it.each([
    [8000, '8K'],
    [128000, '128K'],
    [200000, '200K'],
    [1000000, '1.0M'],
    [2000000, '2.0M'],
    [25000000, '25.0M'],
  ])('renders exact values unchanged: %i', (size, expected) => {
    expect(formatContextWindow(size)).toBe(expected);
  });

  it('falls back to grouped digits below 1000', () => {
    expect(formatContextWindow(448)).toBe('448');
  });
});
