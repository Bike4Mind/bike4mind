import { describe, it, expect } from 'vitest';
import { mayRepublishSlug } from './slugOwnership';

describe('mayRepublishSlug', () => {
  const existing = { ownerId: 'owner1' };

  it.each([
    ['owner', 'user', { id: 'owner1' }, true],
    ['non-owner', 'user', { id: 'member2' }, false],
    ['non-owner, isAdmin undefined', 'project', { id: 'member2', isAdmin: undefined }, false],
    ['non-owner, isAdmin false', 'project', { id: 'member2', isAdmin: false }, false],
    ['admin', 'user', { id: 'admin9', isAdmin: true }, true],
    ['org member who is not the owner', 'organization', { id: 'member2' }, true],
  ])('%s on %s tier', (_label, tier, user, expected) => {
    expect(mayRepublishSlug(existing, tier, user)).toBe(expected);
  });
});
