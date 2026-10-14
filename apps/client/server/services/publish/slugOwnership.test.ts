import { describe, it, expect } from 'vitest';
import { mayRepublishSlug } from './slugOwnership';

describe('mayRepublishSlug', () => {
  it.each([
    ['owner', { id: 'owner1' }, true],
    ['non-owner', { id: 'member2' }, false],
    ['non-owner, isAdmin undefined', { id: 'member2', isAdmin: undefined }, false],
    ['non-owner, isAdmin false', { id: 'member2', isAdmin: false }, false],
    ['admin', { id: 'admin9', isAdmin: true }, true],
  ])('%s', (_label, user, expected) => {
    expect(mayRepublishSlug('owner1', user)).toBe(expected);
  });
});
