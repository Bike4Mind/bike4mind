import { describe, it, expect, vi } from 'vitest';
import { findByIdentifier } from './findByIdentifier';

describe('findByIdentifier', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'artifact_react_x_1_0',
    userId: 'owner',
    visibility: 'private',
    createdAt: new Date('2026-01-01'),
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    ...overrides,
  });

  const run = (userId: string, rows: Record<string, unknown>[]) => {
    const find = vi.fn().mockResolvedValue(rows);
    const result = findByIdentifier(userId, { sessionId: 'sess', type: 'react', identifier: 'x' }, {
      db: { artifacts: { find } },
    } as never);
    return { result, find };
  };

  it('returns the owner their own row', async () => {
    await expect(run('owner', [row()]).result).resolves.toEqual({ id: 'artifact_react_x_1_0' });
  });

  it('returns a row shared with the caller through canRead', async () => {
    const shared = row({ permissions: { canRead: ['sharee'], canWrite: [], canDelete: [] } });
    await expect(run('sharee', [shared]).result).resolves.toEqual({ id: 'artifact_react_x_1_0' });
  });

  it('returns null for a stranger on a private row', async () => {
    await expect(run('stranger', [row()]).result).resolves.toBeNull();
  });

  it('returns null for a write-only grant on a private row', async () => {
    const writeOnly = row({ permissions: { canRead: [], canWrite: ['u2'], canDelete: [] } });
    await expect(run('u2', [writeOnly]).result).resolves.toBeNull();
  });

  it('returns the newest readable row', async () => {
    const older = row({ id: 'old', userId: 'a', visibility: 'public', createdAt: new Date('2026-01-01') });
    const newer = row({ id: 'new', userId: 'b', visibility: 'public', createdAt: new Date('2026-02-01') });
    await expect(run('sharee', [older, newer]).result).resolves.toEqual({ id: 'new' });
  });

  it("prefers the caller's own row over a newer readable one", async () => {
    const mine = row({ id: 'mine', userId: 'me', createdAt: new Date('2026-01-01') });
    const theirs = row({ id: 'theirs', userId: 'other', visibility: 'public', createdAt: new Date('2026-02-01') });
    await expect(run('me', [theirs, mine]).result).resolves.toEqual({ id: 'mine' });
  });

  it('skips a newer row the caller cannot read', async () => {
    const readable = row({ id: 'readable', createdAt: new Date('2026-01-01') });
    const hidden = row({ id: 'hidden', userId: 'other', createdAt: new Date('2026-02-01') });
    await expect(run('owner', [hidden, readable]).result).resolves.toEqual({ id: 'readable' });
  });

  it('scopes the query to the session, type and identifier, live rows only', async () => {
    const { result, find } = run('owner', []);
    await result;

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess',
        type: 'react',
        deletedAt: null,
        $or: [{ identifier: 'x' }, { identifier: { $exists: false }, 'metadata.originalIdentifier': 'x' }],
      })
    );
    expect(find.mock.calls[0][0]).not.toHaveProperty('userId');
  });
});
