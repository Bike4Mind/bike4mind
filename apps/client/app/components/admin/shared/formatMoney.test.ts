import { describe, expect, it } from 'vitest';
import { formatMoney, moneyFractionDigits, toMajorUnits } from './formatMoney';

describe('formatMoney', () => {
  it('formats minor units with the currency symbol and separators', () => {
    expect(formatMoney(123456, 'usd')).toBe('$1,234.56');
    expect(formatMoney(1900, 'USD')).toBe('$19.00');
    expect(formatMoney(0, 'usd')).toBe('$0.00');
  });

  it('shows negative money with a leading minus, never in parentheses', () => {
    expect(formatMoney(-1200, 'usd')).toBe('-$12.00');
  });

  it('keeps another currency in its own symbol', () => {
    expect(formatMoney(1900, 'cad')).toBe('CA$19.00');
  });

  it('reads a zero-decimal currency as whole units', () => {
    expect(moneyFractionDigits('jpy')).toBe(0);
    expect(toMajorUnits(1900, 'jpy')).toBe(1900);
    expect(formatMoney(1900, 'jpy')).toBe('\u00a51,900');
  });

  it('goes compact only when asked and from 10,000 major units', () => {
    expect(formatMoney(1_234_567, 'usd', { compact: true })).toBe('$12.3K');
    expect(formatMoney(999_999, 'usd', { compact: true })).toBe('$9,999.99');
    expect(formatMoney(1_234_567, 'usd')).toBe('$12,345.67');
  });
});
