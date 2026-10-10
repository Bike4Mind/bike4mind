import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findByIdMock } = vi.hoisted(() => ({ findByIdMock: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (id: string) => ({ select: () => ({ lean: () => Promise.resolve(findByIdMock(id)) }) }),
  },
}));

import { loadLiveOwner } from './loadLiveOwner';

beforeEach(() => {
  findByIdMock.mockReset();
});

describe('loadLiveOwner', () => {
  it('returns the name of a live owner', async () => {
    findByIdMock.mockReturnValue({ name: 'Ada', isBanned: false, moderation: { status: 'active' } });
    expect(await loadLiveOwner('u1')).toEqual({ name: 'Ada' });
    expect(findByIdMock).toHaveBeenCalledWith('u1');
  });

  it('returns null when the owner no longer exists', async () => {
    findByIdMock.mockReturnValue(null);
    expect(await loadLiveOwner('gone')).toBeNull();
  });

  it('returns null for a banned or suspended owner', async () => {
    findByIdMock.mockReturnValue({ name: 'B', isBanned: true });
    expect(await loadLiveOwner('u1')).toBeNull();
    findByIdMock.mockReturnValue({ name: 'S', moderation: { status: 'suspended' } });
    expect(await loadLiveOwner('u1')).toBeNull();
  });

  it('keeps serving for an owner with only a pending dispute or pending suspension', async () => {
    findByIdMock.mockReturnValue({ name: 'D', disputePending: true, moderation: { status: 'suspend_pending' } });
    expect(await loadLiveOwner('u1')).toEqual({ name: 'D' });
  });

  it('fails closed by propagating a lookup error', async () => {
    findByIdMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(loadLiveOwner('u1')).rejects.toThrow('db down');
  });
});
