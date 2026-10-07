import { describe, expect, it } from 'vitest';
import { effectiveIncludeLibraryFiles } from './includeLibraryFiles';

describe('effectiveIncludeLibraryFiles', () => {
  it.each([
    [undefined, false, true],
    [undefined, true, false],
    [false, false, false],
    [true, true, true],
  ])('flag %s, namesALake %s -> %s', (flag, namesALake, expected) => {
    expect(effectiveIncludeLibraryFiles(flag, namesALake)).toBe(expected);
  });
});
