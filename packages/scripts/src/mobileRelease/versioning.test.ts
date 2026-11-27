import { describe, expect, it } from 'vitest';
import {
  buildNumber,
  formatReleaseTag,
  formatTrainVersion,
  mobileMinimumErrors,
  parseReleaseBuild,
  parseReleaseTag,
  parseTrainVersion,
  trainOf,
  trainVersionForDate,
  type ReleaseBuild,
} from './versioning';

const v = (year: number, month: number, patch: number) => ({ year, month, patch });

describe('parseTrainVersion', () => {
  it('accepts YY.M.PATCH', () => {
    expect(parseTrainVersion('26.11.0')).toEqual(v(26, 11, 0));
    expect(parseTrainVersion('99.12.99')).toEqual(v(99, 12, 99));
    expect(parseTrainVersion('1.1.0')).toEqual(v(1, 1, 0));
  });

  it.each([
    ['', 'empty'],
    ['26.11', 'two parts'],
    ['26.11.0-rc.1', 'pre-release'],
    ['26.11.0+build.5', 'build metadata'],
    ['0.1.0', 'year 0'],
    ['100.1.0', 'three-digit year'],
    ['26.0.0', 'month 0'],
    ['26.13.0', 'month 13'],
    ['26.11.100', 'patch over 99'],
    ['26.011.0', 'leading zero'],
  ])('rejects %s (%s)', value => {
    expect(parseTrainVersion(value)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats a version, its train and its tags', () => {
    expect(formatTrainVersion(v(26, 11, 2))).toBe('26.11.2');
    expect(trainOf(v(26, 11, 2))).toBe('26.11');
    expect(formatReleaseTag({ version: v(26, 11, 2) })).toBe('mobile-v26.11.2');
    expect(formatReleaseTag({ version: v(26, 11, 2), rc: 3 })).toBe('mobile-v26.11.2-rc.3');
  });

  it('derives the train version from the cut date in UTC', () => {
    expect(trainVersionForDate(new Date('2026-11-17T12:00:00Z'))).toEqual(v(26, 11, 0));
    expect(trainVersionForDate(new Date('2026-12-31T23:59:59Z'))).toEqual(v(26, 12, 0));
  });
});

describe('parseReleaseBuild', () => {
  it('treats a missing or empty rc as the final build', () => {
    expect(parseReleaseBuild('26.11.0')).toEqual({ version: v(26, 11, 0) });
    expect(parseReleaseBuild('26.11.0', '')).toEqual({ version: v(26, 11, 0) });
  });

  it('accepts rc 1 to 98', () => {
    expect(parseReleaseBuild('26.11.0', '1')).toEqual({ version: v(26, 11, 0), rc: 1 });
    expect(parseReleaseBuild('26.11.0', '98')).toEqual({ version: v(26, 11, 0), rc: 98 });
  });

  it.each(['0', '99', '01', '-1', 'x', '1.5'])('rejects rc "%s"', rc => {
    expect(parseReleaseBuild('26.11.0', rc)).toBeUndefined();
  });

  it('rejects a bad version', () => {
    expect(parseReleaseBuild('26.11', '1')).toBeUndefined();
  });
});

describe('parseReleaseTag', () => {
  it('parses final and rc tags', () => {
    expect(parseReleaseTag('mobile-v26.11.0')).toEqual({ version: v(26, 11, 0) });
    expect(parseReleaseTag('mobile-v26.11.1-rc.4')).toEqual({ version: v(26, 11, 1), rc: 4 });
  });

  it.each([
    'v26.11.0',
    'mobile-v26.11',
    'mobile-v26.11.0-beta.1',
    'mobile-v26.11.0-rc.',
    'mobile-v26.11.0-rc.0',
    'mobile-v26.11.0-rc.99',
    'mobile-v26.13.0-rc.1',
  ])('rejects %s', tag => {
    expect(parseReleaseTag(tag)).toBeUndefined();
  });

  it('round-trips through formatReleaseTag', () => {
    const builds: ReleaseBuild[] = [{ version: v(26, 1, 0) }, { version: v(27, 12, 99), rc: 98 }];
    for (const build of builds) expect(parseReleaseTag(formatReleaseTag(build))).toEqual(build);
  });
});

describe('buildNumber', () => {
  it('lays out YYMMPPSS with the final build in slot 99', () => {
    expect(buildNumber({ version: v(26, 11, 0), rc: 1 })).toBe(26_11_00_01);
    expect(buildNumber({ version: v(26, 11, 0) })).toBe(26_11_00_99);
    expect(buildNumber({ version: v(99, 12, 99) })).toBe(99_12_99_99);
  });

  it('rises from rc to final to the next patch to the next train', () => {
    const order: ReleaseBuild[] = [
      { version: v(26, 11, 0), rc: 1 },
      { version: v(26, 11, 0), rc: 2 },
      { version: v(26, 11, 0) },
      { version: v(26, 11, 1), rc: 1 },
      { version: v(26, 11, 1) },
      { version: v(26, 12, 0), rc: 1 },
      { version: v(27, 1, 0), rc: 1 },
    ];
    const numbers = order.map(buildNumber);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('stays under the Play versionCode ceiling', () => {
    expect(buildNumber({ version: v(99, 12, 99) })).toBeLessThan(2_100_000_000);
  });
});

describe('mobileMinimumErrors', () => {
  it('accepts train minimums and ignores other clients', () => {
    expect(mobileMinimumErrors({ 'b4m-ios': '26.11.0', 'b4m-sdk-ts': '2.1.0-rc.1' })).toEqual([]);
    expect(mobileMinimumErrors({})).toEqual([]);
  });

  it('flags a mobile minimum that no store build can send', () => {
    expect(mobileMinimumErrors({ 'b4m-ios': '26.11.0-rc.1', 'b4m-android': '0.1.0' })).toEqual([
      'b4m-ios: "26.11.0-rc.1" is not a train version (YY.M.PATCH, e.g. 26.11.0)',
      'b4m-android: "0.1.0" is not a train version (YY.M.PATCH, e.g. 26.11.0)',
    ]);
  });
});
