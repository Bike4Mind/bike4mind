import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const { findByIdMock, findMock, distinctMock } = vi.hoisted(() => ({
  findByIdMock: vi.fn(),
  findMock: vi.fn(),
  distinctMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (id: string) => ({ select: () => ({ lean: () => Promise.resolve(findByIdMock(id)) }) }),
    find: (query: unknown) => ({ select: () => ({ lean: () => Promise.resolve(findMock(query)) }) }),
  },
  PublishedArtifact: { distinct: (field: string, query: unknown) => Promise.resolve(distinctMock(field, query)) },
}));

import { excludeNonLiveOwners, loadLiveOwner } from './loadLiveOwner';

beforeEach(() => {
  findByIdMock.mockReset();
  findMock.mockReset();
  distinctMock.mockReset();
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

describe('excludeNonLiveOwners', () => {
  const LIVE = '650000000000000000000001';
  const SUSPENDED = '650000000000000000000002';
  const GONE = '650000000000000000000003';
  const FILTER = { deletedAt: null };

  it('excludes owners the live-owner query does not return, the caller aside', async () => {
    distinctMock.mockReturnValue([LIVE, SUSPENDED, GONE]);
    findMock.mockReturnValue([{ _id: LIVE }]);

    expect(await excludeNonLiveOwners(FILTER, 'caller')).toEqual({ ownerId: { $nin: [SUSPENDED, GONE] } });
    expect(distinctMock).toHaveBeenCalledWith('ownerId', { $and: [FILTER, { ownerId: { $ne: 'caller' } }] });
    expect(findMock).toHaveBeenCalledWith({
      _id: { $in: [LIVE, SUSPENDED, GONE] },
      isBanned: { $ne: true },
      'moderation.status': { $ne: 'suspended' },
    });
  });

  it('returns null when every owner is live', async () => {
    distinctMock.mockReturnValue([LIVE]);
    findMock.mockReturnValue([{ _id: LIVE }]);
    expect(await excludeNonLiveOwners(FILTER, 'caller')).toBeNull();
  });

  it('skips the user lookup when no other owner has a row', async () => {
    distinctMock.mockReturnValue([]);
    expect(await excludeNonLiveOwners(FILTER, 'caller')).toBeNull();
    expect(findMock).not.toHaveBeenCalled();
  });

  it('excludes a malformed owner id without passing it to the user query', async () => {
    distinctMock.mockReturnValue([LIVE, 'not-an-id']);
    findMock.mockReturnValue([{ _id: LIVE }]);

    expect(await excludeNonLiveOwners(FILTER, 'caller')).toEqual({ ownerId: { $nin: ['not-an-id'] } });
    expect(findMock.mock.calls[0][0]._id).toEqual({ $in: [LIVE] });
  });

  it('keeps a live owner whose stored id differs only in casing', async () => {
    distinctMock.mockReturnValue(['ABCDEF000000000000000001']);
    findMock.mockReturnValue([{ _id: 'abcdef000000000000000001' }]);
    expect(await excludeNonLiveOwners(FILTER, 'caller')).toBeNull();
  });
  it('compares BSON owners canonically but preserves their stored values in the exclusion', async () => {
    const live = new Types.ObjectId(LIVE);
    const suspended = new Types.ObjectId(SUSPENDED);
    distinctMock.mockReturnValue([live, suspended, null, 42]);
    findMock.mockReturnValue([{ _id: LIVE }]);

    const result = await excludeNonLiveOwners(FILTER, 'caller');
    expect(result).toEqual({ ownerId: { $nin: [suspended, null, 42] } });
    expect(result?.ownerId.$nin[0]).toBe(suspended);
    expect(findMock.mock.calls[0][0]._id).toEqual({ $in: [LIVE, SUSPENDED] });
  });

  it('keeps the caller own legacy casing or BSON ID without consulting its live state', async () => {
    const caller = 'abcdef000000000000000001';
    distinctMock.mockReturnValue([caller.toUpperCase(), new Types.ObjectId(caller)]);
    expect(await excludeNonLiveOwners(FILTER, caller)).toBeNull();
    expect(findMock).not.toHaveBeenCalled();
  });
});
