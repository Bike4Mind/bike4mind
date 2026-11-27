import { randomUUID } from 'node:crypto';
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

const mintPublicId = () => randomUUID().replace(/-/g, '').slice(0, 12);

describe('parseLiveArtifactRef', () => {
  const id = mintPublicId();
  const scope = '507f1f77bcf86cd799439011';

  it('reads a freshly minted bare publicId as a publicId', () => {
    for (let i = 0; i < 200; i++) {
      const minted = mintPublicId();
      expect(parseLiveArtifactRef(minted)).toEqual({ kind: 'publicId', value: minted });
    }
  });

  it('never returns a slug kind for a bare value', () => {
    expect(parseLiveArtifactRef('my-page')).toEqual({ kind: 'publicId', value: 'my-page' });
  });

  it.each([
    [`/p/r/${id}`, { kind: 'publicId', value: id, tierPath: 'r' }],
    [`/p/f/${id}/`, { kind: 'publicId', value: id, tierPath: 'f' }],
    [`https://other.example.org/p/r/${id}?x=1#y`, { kind: 'publicId', value: id, tierPath: 'r' }],
    [`/p/u/${scope}/my-page`, { kind: 'bundle', tier: 'user', scopeId: scope, slug: 'my-page' }],
    [`https://x.example/p/pj/${scope}/my-page/`, { kind: 'bundle', tier: 'project', scopeId: scope, slug: 'my-page' }],
    [
      `https://x.example/p/o/${scope}/my-page/assets/app.js?v=1`,
      { kind: 'bundle', tier: 'organization', scopeId: scope, slug: 'my-page' },
    ],
    [`  ${id}  `, { kind: 'publicId', value: id }],
  ])('resolves %s', (input, expected) => {
    expect(parseLiveArtifactRef(input)).toEqual(expected);
  });

  it.each([
    '',
    '/p/',
    '/p/r/',
    '/p/r/a/b',
    '/p/my-page',
    '/p/u/my-page',
    `/p/u/${scope}`,
    `/p/x/${scope}/my-page`,
    `/p/constructor/${scope}/my-page`,
    `/p/__proto__/${scope}/my-page`,
    `/p/toString/${scope}/my-page`,
    '/p/a/abcDEF123_-token',
    `/p/u/${scope}/Bad_Slug`,
    '/a/abcDEF123_-token',
    '/u/Abc123',
    'https://x.test/other',
    '/p/r/a b',
    'a/b',
    '../x',
    '/p/r/..',
  ])('refuses %j', input => {
    expect(parseLiveArtifactRef(input)).toBeNull();
    expect(liveArtifactRefSchema.safeParse(input).success).toBe(false);
  });
});
