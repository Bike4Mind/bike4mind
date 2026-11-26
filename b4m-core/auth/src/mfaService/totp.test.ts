import { describe, expect, it } from 'vitest';
import { decodeBase32, encodeBase32, generateTOTPSecret, totpAuthUrl, totpCode } from './totp';

// RFC 4648 section 10, without the padding.
const RFC4648 = [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
] as const;

describe('base32', () => {
  it.each(RFC4648)('encodes %j as %j and back', (text, encoded) => {
    expect(encodeBase32(Buffer.from(text))).toBe(encoded);
    expect(decodeBase32(encoded).toString()).toBe(text);
  });

  it('round-trips random bytes', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 73 + length) & 0xff));
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  it('decodes leniently, as speakeasy did', () => {
    expect(decodeBase32('mzxw6ytboi')).toEqual(Buffer.from('foobar'));
    expect(decodeBase32('MZXW6YQ=')).toEqual(Buffer.from('foob'));
    expect(decodeBase32('01')).toEqual(decodeBase32('OI'));
    expect(decodeBase32('M ZX')).toEqual(decodeBase32('MAZX'));
    expect(decodeBase32('B')).toEqual(Buffer.from([0x08]));
    expect(decodeBase32('A')).toEqual(Buffer.alloc(0));
  });
});

describe('totpCode', () => {
  // RFC 6238 Appendix B (SHA-1), last six digits.
  const secret = encodeBase32(Buffer.from('12345678901234567890'));

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the RFC 6238 vector at T=%i', (seconds, code) => {
    expect(totpCode(secret, Math.floor(seconds / 30))).toBe(code);
  });
});

describe('generateTOTPSecret', () => {
  it('returns 52 base32 characters holding 32 random bytes', () => {
    const secret = generateTOTPSecret();
    expect(secret).toMatch(/^[A-Z2-7]{52}$/);
    expect(decodeBase32(secret)).toHaveLength(32);
    expect(generateTOTPSecret()).not.toBe(secret);
  });
});

describe('totpAuthUrl', () => {
  it('percent-encodes the label', () => {
    expect(totpAuthUrl('JBSWY3DPEHPK3PXP', 'App (a+b@example.com)')).toBe(
      'otpauth://totp/App%20(a%2Bb%40example.com)?secret=JBSWY3DPEHPK3PXP'
    );
  });
});
