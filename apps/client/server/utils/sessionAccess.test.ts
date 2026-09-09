import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { assertSessionAccess, canAccessSession, filterReadableQuests } from './sessionAccess';

const mockSessionFindById = vi.fn();

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: (...args: unknown[]) => mockSessionFindById(...args),
  },
}));

describe('sessionAccess', () => {
  const userA = new Types.ObjectId().toString();
  const userB = new Types.ObjectId().toString();
  const sessionId = new Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canAccessSession', () => {
    it('grants the owner', () => {
      expect(canAccessSession({ userId: userA, users: [] }, userA)).toBe(true);
    });

    it('grants a shared user', () => {
      expect(canAccessSession({ userId: userB, users: [{ userId: userA, permissions: [] }] } as any, userA)).toBe(true);
    });

    it('denies a user who is neither owner nor shared', () => {
      expect(canAccessSession({ userId: userB, users: [] }, userA)).toBe(false);
    });

    it('denies when users is undefined', () => {
      expect(canAccessSession({ userId: userB } as any, userA)).toBe(false);
    });

    it('grants read on a globally-readable session', () => {
      expect(canAccessSession({ userId: userB, users: [], isGlobalRead: true } as any, userA)).toBe(true);
    });

    it('does NOT grant write on a globally-readable session', () => {
      expect(canAccessSession({ userId: userB, users: [], isGlobalRead: true } as any, userA, 'write')).toBe(false);
    });

    it('grants both read and write on a globally-writable session', () => {
      const session = { userId: userB, users: [], isGlobalWrite: true } as any;
      expect(canAccessSession(session, userA)).toBe(true);
      expect(canAccessSession(session, userA, 'write')).toBe(true);
    });

    it('grants write to a user-share carrying update', () => {
      const session = { userId: userB, users: [{ userId: userA, permissions: ['update'] }] } as any;
      expect(canAccessSession(session, userA, 'write')).toBe(true);
    });

    it('reads but does not write on a read-only user-share', () => {
      const session = { userId: userB, users: [{ userId: userA, permissions: ['read'] }] } as any;
      expect(canAccessSession(session, userA)).toBe(true);
      expect(canAccessSession(session, userA, 'write')).toBe(false);
    });

    it('grants write to a group-share carrying update, only to members of that group', () => {
      // The write arm delegates to canUpdateShareable, so a group-share resolves against userGroups.
      const session = { userId: userB, users: [], groups: [{ groupId: 'g1', permissions: ['update'] }] } as any;
      expect(canAccessSession(session, userA, 'write', ['g1'])).toBe(true);
      expect(canAccessSession(session, userA, 'write', ['g2'])).toBe(false);
      expect(canAccessSession(session, userA, 'write')).toBe(false);
    });
  });

  describe('assertSessionAccess', () => {
    it('throws UnauthorizedError when userId is missing', async () => {
      await expect(assertSessionAccess(sessionId, undefined)).rejects.toThrow(UnauthorizedError);
    });

    it('throws BadRequestError for a non-ObjectId session id', async () => {
      await expect(assertSessionAccess('not-an-id', userA)).rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError when session id is missing', async () => {
      await expect(assertSessionAccess(undefined, userA)).rejects.toThrow(BadRequestError);
    });

    it('throws NotFoundError when the session does not exist', async () => {
      mockSessionFindById.mockResolvedValue(null);
      await expect(assertSessionAccess(sessionId, userA)).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError (not Forbidden) when the caller is not owner or shared', async () => {
      mockSessionFindById.mockResolvedValue({ userId: userB, users: [] });
      await expect(assertSessionAccess(sessionId, userA)).rejects.toThrow(NotFoundError);
    });

    it('returns the session for the owner', async () => {
      const session = { userId: userA, users: [] };
      mockSessionFindById.mockResolvedValue(session);
      await expect(assertSessionAccess(sessionId, userA)).resolves.toBe(session);
    });

    it('returns the session for a shared collaborator (no over-denial)', async () => {
      const session = { userId: userB, users: [{ userId: userA, permissions: [] }] };
      mockSessionFindById.mockResolvedValue(session);
      await expect(assertSessionAccess(sessionId, userA)).resolves.toBe(session);
    });

    it('returns the session for a viewer of a globally-readable session (no over-denial)', async () => {
      const session = { userId: userB, users: [], isGlobalRead: true };
      mockSessionFindById.mockResolvedValue(session);
      await expect(assertSessionAccess(sessionId, userA)).resolves.toBe(session);
    });

    it('denies a write when the caller only holds a read-level share', async () => {
      mockSessionFindById.mockResolvedValue({ userId: userB, users: [{ userId: userA, permissions: ['read'] }] });
      await expect(assertSessionAccess(sessionId, userA, 'write')).rejects.toThrow(NotFoundError);
    });
  });

  describe('filterReadableQuests', () => {
    const ownedSession = new Types.ObjectId().toString();
    const foreignSession = new Types.ObjectId().toString();

    beforeEach(() => {
      mockSessionFindById.mockImplementation(async (id: string) => {
        if (id === ownedSession) return { userId: userA, users: [] };
        if (id === foreignSession) return { userId: userB, users: [] };
        return null;
      });
    });

    it("keeps the owner's quests and drops a foreign quest", async () => {
      const quests = [
        { _id: 'q1', sessionId: ownedSession },
        { _id: 'q2', sessionId: foreignSession },
      ];
      const result = await filterReadableQuests(quests, userA);
      expect(result).toEqual([{ _id: 'q1', sessionId: ownedSession }]);
    });

    it('drops a quest whose session is missing', async () => {
      const missing = new Types.ObjectId().toString();
      const result = await filterReadableQuests([{ _id: 'q1', sessionId: missing }], userA);
      expect(result).toEqual([]);
    });

    it('loads each distinct session only once', async () => {
      await filterReadableQuests(
        [
          { _id: 'q1', sessionId: ownedSession },
          { _id: 'q2', sessionId: ownedSession },
        ],
        userA
      );
      expect(mockSessionFindById).toHaveBeenCalledTimes(1);
    });

    it('keeps a quest whose session is shared with the caller', async () => {
      const shared = new Types.ObjectId().toString();
      mockSessionFindById.mockResolvedValue({ userId: userB, users: [{ userId: userA, permissions: [] }] });
      const result = await filterReadableQuests([{ _id: 'q1', sessionId: shared }], userA);
      expect(result).toHaveLength(1);
    });
  });
});
