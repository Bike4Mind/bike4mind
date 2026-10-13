import { describe, expect, it } from 'vitest';
import { isSubmittableOtcCode, OTC_CODE_LENGTH, OTC_CODE_PLACEHOLDER, sanitizeOtcInput } from './otcCode';

describe('otcCode', () => {
  it('uses 8-digit codes', () => {
    expect(OTC_CODE_LENGTH).toBe(8);
    expect(OTC_CODE_PLACEHOLDER).toBe('00000000');
  });

  it('keeps all 8 digits of a pasted code and drops separators', () => {
    expect(sanitizeOtcInput(' 1234-5678 ')).toBe('12345678');
    expect(sanitizeOtcInput('123456789')).toBe('12345678');
  });

  it('accepts a full 8-digit code and a legacy 6-digit code, nothing else', () => {
    expect(isSubmittableOtcCode('12345678')).toBe(true);
    expect(isSubmittableOtcCode('123456')).toBe(true);
    expect(isSubmittableOtcCode('1234567')).toBe(false);
    expect(isSubmittableOtcCode('12345')).toBe(false);
    expect(isSubmittableOtcCode('')).toBe(false);
  });
});
