import { describe, it, expect } from 'vitest';
import {
  compareSemVer,
  MinimumClientVersionsSchema,
  parseClientIdentity,
  parseSemVer,
  requiredClientUpgrade,
  type SemVer,
} from './clientVersion';

const semver = (value: string): SemVer => {
  const parsed = parseSemVer(value);
  if (!parsed) throw new Error(`fixture ${value} is not a SemVer`);
  return parsed;
};

describe('parseSemVer', () => {
  it.each([
    '0.0.0',
    '1.2.3',
    '10.20.30',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0+20130313144700',
    '1.0.0-beta+exp.sha.5114f85',
  ])('accepts %s', value => {
    expect(parseSemVer(value)).toBeDefined();
  });

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-a..b',
    '1.2.3+',
    '1.2.3 beta',
    `1.2.3-${'a'.repeat(64)}`,
  ])('rejects %j', value => {
    expect(parseSemVer(value)).toBeUndefined();
  });

  it('splits the core and pre-release', () => {
    expect(parseSemVer('2.10.0-rc.1+build.7')).toEqual({ major: 2, minor: 10, patch: 0, prerelease: ['rc', '1'] });
  });
});

describe('compareSemVer', () => {
  // The precedence chain from SemVer 2.0.0 section 11.
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
    '10.0.0',
  ];

  it('orders the spec precedence chain', () => {
    for (let index = 1; index < ordered.length; index++) {
      expect(compareSemVer(semver(ordered[index - 1]), semver(ordered[index]))).toBe(-1);
      expect(compareSemVer(semver(ordered[index]), semver(ordered[index - 1]))).toBe(1);
    }
  });

  it('ignores build metadata', () => {
    expect(compareSemVer(semver('1.0.0+a'), semver('1.0.0+b'))).toBe(0);
  });
});

describe('parseClientIdentity', () => {
  it('reads both headers', () => {
    expect(parseClientIdentity({ 'x-client-name': 'b4m-sdk-ts', 'x-client-version': '2.0.0' })).toEqual({
      name: 'b4m-sdk-ts',
      version: '2.0.0',
    });
  });

  it('lowercases the name and trims both values', () => {
    expect(parseClientIdentity({ 'x-client-name': ' B4M-SDK-TS ', 'x-client-version': ' 2.0.0 ' })).toEqual({
      name: 'b4m-sdk-ts',
      version: '2.0.0',
    });
  });

  it('is absent when no header is sent', () => {
    expect(parseClientIdentity({})).toBeUndefined();
  });

  it('is absent when only one of the pair is sent', () => {
    expect(parseClientIdentity({ 'x-client-name': 'b4m-sdk-ts' })).toBeUndefined();
    expect(parseClientIdentity({ 'x-client-version': '2.0.0' })).toBeUndefined();
  });

  it.each([
    ['a non-SemVer version', { 'x-client-name': 'b4m-sdk-ts', 'x-client-version': 'latest' }],
    ['a name with invalid characters', { 'x-client-name': 'b4m sdk', 'x-client-version': '2.0.0' }],
    ['an over-long name', { 'x-client-name': 'a'.repeat(65), 'x-client-version': '2.0.0' }],
    ['a repeated header', { 'x-client-name': ['a', 'b'], 'x-client-version': '2.0.0' }],
  ])('is absent for %s', (_label, headers) => {
    expect(parseClientIdentity(headers)).toBeUndefined();
  });
});

describe('requiredClientUpgrade', () => {
  const minimums = { 'b4m-sdk-ts': '2.1.0' };

  it('lets a client exactly at the minimum through', () => {
    expect(requiredClientUpgrade({ name: 'b4m-sdk-ts', version: '2.1.0' }, minimums)).toBeUndefined();
  });

  it('lets a newer client through', () => {
    expect(requiredClientUpgrade({ name: 'b4m-sdk-ts', version: '2.1.1' }, minimums)).toBeUndefined();
  });

  it('asks a client one patch below the minimum to upgrade', () => {
    expect(requiredClientUpgrade({ name: 'b4m-sdk-ts', version: '2.0.9' }, minimums)).toBe('2.1.0');
  });

  it('asks a pre-release of the minimum to upgrade', () => {
    expect(requiredClientUpgrade({ name: 'b4m-sdk-ts', version: '2.1.0-rc.1' }, minimums)).toBe('2.1.0');
  });

  it('never gates an undeclared client', () => {
    expect(requiredClientUpgrade(undefined, minimums)).toBeUndefined();
  });

  it('never gates a client with no configured minimum', () => {
    expect(requiredClientUpgrade({ name: 'other-client', version: '0.0.1' }, minimums)).toBeUndefined();
    expect(requiredClientUpgrade({ name: 'constructor', version: '0.0.1' }, minimums)).toBeUndefined();
  });

  it('is off with an empty map', () => {
    expect(requiredClientUpgrade({ name: 'b4m-sdk-ts', version: '0.0.1' }, {})).toBeUndefined();
  });
});

describe('MinimumClientVersionsSchema', () => {
  it('accepts a name -> version map', () => {
    expect(MinimumClientVersionsSchema.parse({ 'b4m-sdk-ts': '2.1.0' })).toEqual({ 'b4m-sdk-ts': '2.1.0' });
  });

  it('rejects a bad version or name', () => {
    expect(MinimumClientVersionsSchema.safeParse({ 'b4m-sdk-ts': '2.1' }).success).toBe(false);
    expect(MinimumClientVersionsSchema.safeParse({ 'B4M SDK': '2.1.0' }).success).toBe(false);
  });
});
