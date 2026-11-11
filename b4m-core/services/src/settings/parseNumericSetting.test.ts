import { describe, expect, it, vi } from 'vitest';
import { parseNumericSetting } from './parseNumericSetting';

const spec = { key: 'limit', fallback: 10, min: 1, max: 100, int: true };

describe('parseNumericSetting', () => {
  it('uses the fallback when the value is absent or blank', () => {
    expect(parseNumericSetting(undefined, spec)).toBe(10);
    expect(parseNumericSetting(null, spec)).toBe(10);
    expect(parseNumericSetting('  ', spec)).toBe(10);
  });

  it('accepts a number or numeric string and floors an integer setting', () => {
    expect(parseNumericSetting(5, spec)).toBe(5);
    expect(parseNumericSetting('7.9', spec)).toBe(7);
  });

  it('clamps a value above the ceiling and warns', () => {
    const warn = vi.fn();
    expect(parseNumericSetting('1000', spec, { warn } as never)).toBe(100);
    expect(warn).toHaveBeenCalled();
  });

  it('throws on an unparseable value or one below the minimum', () => {
    expect(() => parseNumericSetting('lots', spec)).toThrow("setting 'limit' has an invalid value");
    expect(() => parseNumericSetting('0', spec)).toThrow('minimum 1');
    expect(() => parseNumericSetting(-1, { ...spec, min: 0 })).toThrow('minimum 0');
  });

  it('allows zero when the minimum is zero', () => {
    expect(parseNumericSetting('0', { ...spec, min: 0 })).toBe(0);
  });
});
