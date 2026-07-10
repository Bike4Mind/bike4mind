import { describe, it, expect } from 'vitest';
import {
  parseInternalStaffDomains,
  internalStaffEmailRegex,
  parseInternalOrgDisplayNames,
} from '../utils/internalStaffDomains';

describe('parseInternalStaffDomains', () => {
  it('parses a comma-separated list', () => {
    expect(parseInternalStaffDomains('bike4mind.com,milliononmars.com')).toEqual([
      'bike4mind.com',
      'milliononmars.com',
    ]);
  });

  it('trims whitespace and lowercases', () => {
    expect(parseInternalStaffDomains(' Bike4Mind.com , MILLIONONMARS.com ')).toEqual([
      'bike4mind.com',
      'milliononmars.com',
    ]);
  });

  it('drops empties and de-duplicates', () => {
    expect(parseInternalStaffDomains('bike4mind.com,,bike4mind.com,')).toEqual(['bike4mind.com']);
  });

  it('returns [] for unset/empty (no brand fallback)', () => {
    expect(parseInternalStaffDomains(undefined)).toEqual([]);
    expect(parseInternalStaffDomains('')).toEqual([]);
    expect(parseInternalStaffDomains('  ,  ')).toEqual([]);
  });
});

describe('internalStaffEmailRegex', () => {
  it('matches every configured domain (the issue #172 regression: both, not just one)', () => {
    const re = internalStaffEmailRegex(['bike4mind.com', 'milliononmars.com'])!;
    expect(re.test('alice@bike4mind.com')).toBe(true);
    expect(re.test('bob@milliononmars.com')).toBe(true);
  });

  it('is anchored to the domain and does not match substrings or other domains', () => {
    const re = internalStaffEmailRegex(['bike4mind.com'])!;
    expect(re.test('eve@notbike4mind.com')).toBe(false);
    expect(re.test('eve@bike4mind.company.com')).toBe(false);
    expect(re.test('eve@gmail.com')).toBe(false);
  });

  it('is case-insensitive (matches the entitlement layer lowercase semantics)', () => {
    const re = internalStaffEmailRegex(['bike4mind.com'])!;
    expect(re.test('Alice@Bike4Mind.com')).toBe(true);
  });

  it('escapes regex metacharacters in the dot so it is a literal', () => {
    const re = internalStaffEmailRegex(['bike4mind.com'])!;
    // The "." must be literal, not "any char" — so "bike4mindXcom" must NOT match.
    expect(re.test('alice@bike4mindXcom')).toBe(false);
  });

  it('returns null when no domains are configured (caller skips matching)', () => {
    expect(internalStaffEmailRegex([])).toBeNull();
  });
});

describe('parseInternalOrgDisplayNames', () => {
  it('parses `domain:Label` pairs into a map', () => {
    expect(parseInternalOrgDisplayNames('milliononmars.com:Million on Mars')).toEqual({
      'milliononmars.com': 'Million on Mars',
    });
  });

  it('parses multiple comma-separated pairs', () => {
    expect(parseInternalOrgDisplayNames('milliononmars.com:Million on Mars,acme.com:Acme Corp')).toEqual({
      'milliononmars.com': 'Million on Mars',
      'acme.com': 'Acme Corp',
    });
  });

  it('lowercases the domain but preserves the label verbatim', () => {
    expect(parseInternalOrgDisplayNames(' MILLIONONMARS.com : Million on Mars ')).toEqual({
      'milliononmars.com': 'Million on Mars',
    });
  });

  it('keeps colons in the label (splits on the first colon only)', () => {
    expect(parseInternalOrgDisplayNames('acme.com:Acme: The Sequel')).toEqual({
      'acme.com': 'Acme: The Sequel',
    });
  });

  it('skips entries without a colon or with an empty domain/label', () => {
    expect(parseInternalOrgDisplayNames('nolabelhere,:orphan,acme.com:,acme.com:Acme')).toEqual({
      'acme.com': 'Acme',
    });
  });

  it('returns {} for unset/empty (no brand fallback)', () => {
    expect(parseInternalOrgDisplayNames(undefined)).toEqual({});
    expect(parseInternalOrgDisplayNames('')).toEqual({});
    expect(parseInternalOrgDisplayNames('  ,  ')).toEqual({});
  });
});
