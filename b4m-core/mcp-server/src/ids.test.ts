import { describe, expect, it } from 'vitest';
import { isObjectId, isPublicId, isSlug, isUuid, liveArtifactRefSchema, parseLiveArtifactRef } from './ids';

describe('id validators', () => {
  it('publicId', () => {
    expect(isPublicId('Ab_-9')).toBe(true);
    expect(isPublicId('a'.repeat(64))).toBe(true);
    for (const bad of ['', 'a'.repeat(65), 'a/b', 'a b', '..', 7]) expect(isPublicId(bad)).toBe(false);
  });
  it('objectId', () => {
    expect(isObjectId('0123456789abcdef01234567')).toBe(true);
    for (const bad of ['0123456789abcdef0123456', '0123456789abcdef0123456z', '']) expect(isObjectId(bad)).toBe(false);
  });
  it('uuid', () => {
    expect(isUuid('0b9b6c3e-6a4f-4d0e-9f1a-2c3d4e5f6a7b')).toBe(true);
    for (const bad of ['0b9b6c3e6a4f4d0e9f1a2c3d4e5f6a7b', 'nope', '']) expect(isUuid(bad)).toBe(false);
  });
  it('slug', () => {
    expect(isSlug('my-page')).toBe(true);
    for (const bad of ['My-Page', 'a', 'api', 'a--b', '-a-']) expect(isSlug(bad)).toBe(false);
  });
});

describe('parseLiveArtifactRef', () => {
  it.each([
    ['/p/r/Abc123', { kind: 'publicId', value: 'Abc123', tierPath: 'r' }],
    ['/p/f/Abc123/', { kind: 'publicId', value: 'Abc123', tierPath: 'f' }],
    ['https://other.example.org/p/r/Abc123?x=1#y', { kind: 'publicId', value: 'Abc123', tierPath: 'r' }],
    ['/p/my-page', { kind: 'slug', value: 'my-page' }],
    ['my-page', { kind: 'slug', value: 'my-page' }],
    ['Abc_123', { kind: 'publicId', value: 'Abc_123' }],
    ['  my-page  ', { kind: 'slug', value: 'my-page' }],
  ])('resolves %s', (input, expected) => {
    expect(parseLiveArtifactRef(input)).toEqual(expected);
  });

  it.each(['', '/p/', '/p/r/', '/p/r/a/b', '/u/Abc123', 'https://x.test/other', '/p/r/a b', 'a/b', '../x', '/p/r/..'])(
    'refuses %j',
    input => {
      expect(parseLiveArtifactRef(input)).toBeNull();
      expect(liveArtifactRefSchema.safeParse(input).success).toBe(false);
    }
  );
});
