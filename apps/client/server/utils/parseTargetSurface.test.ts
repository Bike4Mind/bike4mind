import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@server/utils/errors';
import { parseTargetSurface } from './parseTargetSurface';

describe('parseTargetSurface', () => {
  it('reads an absent field, or no body at all, as inherit', () => {
    expect(parseTargetSurface(undefined)).toBeUndefined();
    expect(parseTargetSurface({})).toBeUndefined();
    expect(parseTargetSurface('')).toBeUndefined();
  });

  it('passes a surface string or null through', () => {
    expect(parseTargetSurface({ targetSurface: 'opti' })).toBe('opti');
    expect(parseTargetSurface({ targetSurface: null })).toBeNull();
  });

  it.each([3, true, ['opti'], { id: 'opti' }])('400s a non-string targetSurface (%j)', value => {
    expect(() => parseTargetSurface({ targetSurface: value })).toThrow(BadRequestError);
  });
});
