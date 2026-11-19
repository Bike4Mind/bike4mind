import { describe, expect, it, vi } from 'vitest';
import { ApiKeyStatus } from '@bike4mind/common';
import { findKeyModerationExceptionCategories, moderationExceptionCovers } from './moderationException';

describe('moderationExceptionCovers', () => {
  it('covers a result whose every label is on the key', () => {
    expect(moderationExceptionCovers(['violence'], ['violence', 'violence/graphic'])).toBe(true);
    expect(moderationExceptionCovers(['violence', 'violence/graphic'], ['violence', 'violence/graphic'])).toBe(true);
    expect(moderationExceptionCovers(['VIOLENCE'], ['VIOLENCE'])).toBe(true);
  });

  it('keeps the block when one label is not on the key', () => {
    expect(moderationExceptionCovers(['violence', 'hate'], ['violence', 'violence/graphic'])).toBe(false);
    expect(moderationExceptionCovers(['violence/graphic'], ['violence'])).toBe(false);
  });

  it('keeps the block for a key with no categories and for a result with no labels', () => {
    expect(moderationExceptionCovers(['violence'], [])).toBe(false);
    expect(moderationExceptionCovers([], ['violence'])).toBe(false);
  });

  it('ignores a stored category that is not on the shared list', () => {
    expect(moderationExceptionCovers(['hate'], ['hate'])).toBe(false);
    expect(moderationExceptionCovers(['sexual/minors'], ['sexual/minors', 'violence'])).toBe(false);
  });

  it('matches labels exactly', () => {
    expect(moderationExceptionCovers(['Violence'], ['violence'])).toBe(false);
    expect(moderationExceptionCovers(['violence'], ['VIOLENCE'])).toBe(false);
    expect(moderationExceptionCovers(['word:violence'], ['violence'])).toBe(false);
  });
});

describe('findKeyModerationExceptionCategories', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const stored = (overrides: Record<string, unknown> = {}) => ({
    userId: 'user-1',
    status: ApiKeyStatus.ACTIVE,
    expiresAt: undefined,
    moderationException: { categories: ['violence' as const], reason: 'r', setBy: 'admin-1', setAt: now },
    ...overrides,
  });
  const adapters = (value: unknown) => ({
    userApiKeys: { findModerationException: vi.fn().mockResolvedValue(value) },
  });

  it('returns the categories of an active key owned by the turn user', async () => {
    const db = adapters(stored());
    await expect(findKeyModerationExceptionCategories('key-1', 'user-1', db, now)).resolves.toEqual(['violence']);
    expect(db.userApiKeys.findModerationException).toHaveBeenCalledExactlyOnceWith('key-1');
  });

  it.each([
    ['a key with no exception', null],
    ['a key owned by another user', stored({ userId: 'user-2' })],
    ['a disabled key', stored({ status: ApiKeyStatus.DISABLED })],
    ['an expired key', stored({ expiresAt: new Date('2025-12-31T23:59:59.000Z') })],
  ])('returns nothing for %s', async (_label, value) => {
    await expect(findKeyModerationExceptionCategories('key-1', 'user-1', adapters(value), now)).resolves.toEqual([]);
  });
});
