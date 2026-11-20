import { describe, it, expect } from 'vitest';
import { canAccessTavern, hasTavernUserTag, hasDeveloperUserTag, isFreeTierExempt } from './user';

describe('hasTavernUserTag', () => {
  it('matches the "tavern" tag case-insensitively', () => {
    expect(hasTavernUserTag(['tavern'])).toBe(true);
    expect(hasTavernUserTag(['Tavern'])).toBe(true);
    expect(hasTavernUserTag(['TAVERN'])).toBe(true);
    expect(hasTavernUserTag(['Analyst', 'tavern'])).toBe(true);
  });

  it('is false for unrelated, empty, null, or undefined tags', () => {
    expect(hasTavernUserTag(['Analyst', 'Developer'])).toBe(false);
    expect(hasTavernUserTag([])).toBe(false);
    expect(hasTavernUserTag(null)).toBe(false);
    expect(hasTavernUserTag(undefined)).toBe(false);
  });

  it('does not grant on a developer tag (distinct from hasDeveloperUserTag)', () => {
    expect(hasTavernUserTag(['Developer'])).toBe(false);
    expect(hasDeveloperUserTag(['Developer'])).toBe(true);
  });
});

describe('canAccessTavern', () => {
  it('grants admins regardless of tags', () => {
    expect(canAccessTavern({ isAdmin: true })).toBe(true);
    expect(canAccessTavern({ isAdmin: true, tags: [] })).toBe(true);
  });

  it('grants non-admins holding the tavern tag', () => {
    expect(canAccessTavern({ isAdmin: false, tags: ['tavern'] })).toBe(true);
    expect(canAccessTavern({ tags: ['Tavern'] })).toBe(true);
  });

  it('grants developer-tagged users', () => {
    expect(canAccessTavern({ isAdmin: false, tags: ['Developer'] })).toBe(true);
    expect(canAccessTavern({ tags: ['dev'] })).toBe(true);
  });

  it('denies non-admins without the tavern tag', () => {
    expect(canAccessTavern({ isAdmin: false, tags: [] })).toBe(false);
    expect(canAccessTavern({ isAdmin: false, tags: ['Analyst'] })).toBe(false);
    expect(canAccessTavern({})).toBe(false);
  });

  it('denies a null/undefined user (unauthenticated)', () => {
    expect(canAccessTavern(null)).toBe(false);
    expect(canAccessTavern(undefined)).toBe(false);
  });
});

describe('isFreeTierExempt', () => {
  it('exempts admins and developer-tagged users', () => {
    expect(isFreeTierExempt({ isAdmin: true })).toBe(true);
    expect(isFreeTierExempt({ isAdmin: false, tags: ['Developer'] })).toBe(true);
  });

  it('does not exempt other tags, empty tags or a missing user shape', () => {
    expect(isFreeTierExempt({ isAdmin: false, tags: ['developer-ish', 'tavern'] })).toBe(false);
    expect(isFreeTierExempt({ isAdmin: null, tags: null })).toBe(false);
    expect(isFreeTierExempt({})).toBe(false);
  });
});
