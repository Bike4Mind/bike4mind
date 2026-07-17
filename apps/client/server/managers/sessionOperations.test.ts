import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock state via vi.hoisted so it is initialized before the hoisted vi.mock factories run.
const { createSessionMock, sideEffects, QuestMock, SessionMock, findAccessibleById } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  sideEffects: {
    publishSummarizeSession: vi.fn().mockResolvedValue(undefined),
    publishContextSummarizeSession: vi.fn().mockResolvedValue(undefined),
  },
  QuestMock: {
    find: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  SessionMock: {
    findById: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue(undefined),
    where: vi.fn(),
  },
  findAccessibleById: vi.fn(),
}));

// ---- cross-module + side-effect boundaries ----
vi.mock('./sessionCrud', () => ({ createSession: createSessionMock }));
vi.mock('./sessionSideEffects', () => sideEffects);

vi.mock('@bike4mind/database', () => ({
  Quest: QuestMock,
  Session: SessionMock,
  mongoose: { Types: { ObjectId: class {} } },
}));

vi.mock('@bike4mind/database/auth', () => ({
  Session: { modelName: 'Session' },
  sessionRepository: { shareable: { findAccessibleById } },
}));

vi.mock('@bike4mind/common', () => ({
  Permission: { update: 'update' },
  // @server/utils/errors re-exports NotFoundError from here, so it must be provided.
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { log: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@casl/mongoose', () => ({
  accessibleBy: () => ({ ofType: () => ({}) }),
}));

import {
  addMessageToSession,
  deleteMessageFromSession,
  stopReply,
  forkSession,
  snipSession,
  cloneSession,
  summarizeSession,
  contextSummarizeSession,
} from './sessionOperations';
import { publishSummarizeSession, publishContextSummarizeSession } from './sessionSideEffects';
import type { Ability } from '@server/auth/ability';
import type { IChatHistoryItem } from '@bike4mind/common';

// Typed casts keep the intended types visible (and catch drift) without real Mongoose docs.
const mockAbility = (canResult: boolean): Ability =>
  ({ can: vi.fn().mockReturnValue(canResult) }) as unknown as Ability;
const mockMessage = (m: Partial<Omit<IChatHistoryItem, 'sessionId'>>): Omit<IChatHistoryItem, 'sessionId'> =>
  m as Omit<IChatHistoryItem, 'sessionId'>;

const ability = mockAbility(true);

describe('sessionOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SessionMock.updateOne.mockResolvedValue(undefined);
  });

  describe('addMessageToSession', () => {
    it('throws NotFoundError when the session is not accessible', async () => {
      SessionMock.findOne.mockResolvedValueOnce(null);
      await expect(addMessageToSession('u1', 's1', mockMessage({ prompt: 'hi' }), ability)).rejects.toThrow(
        'Session not found'
      );
      expect(QuestMock.create).not.toHaveBeenCalled();
    });

    it('creates the quest and bumps the session timestamp', async () => {
      SessionMock.findOne.mockResolvedValueOnce({ id: 's1', lastUpdated: new Date(0) });
      QuestMock.create.mockResolvedValueOnce({ id: 'q1' });

      const result = await addMessageToSession('u1', 's1', mockMessage({ prompt: 'hi' }), ability);

      expect(QuestMock.create).toHaveBeenCalledWith({ prompt: 'hi', sessionId: 's1' });
      expect(SessionMock.updateOne).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'q1' });
    });
  });

  describe('deleteMessageFromSession', () => {
    it('throws when the session is not accessible', async () => {
      SessionMock.findOne.mockResolvedValueOnce(null);
      await expect(deleteMessageFromSession('u1', 's1', 'm1', ability)).rejects.toThrow('Session not found');
    });

    it('soft-deletes the message via deletedAt', async () => {
      SessionMock.findOne.mockResolvedValueOnce({ id: 's1' });
      QuestMock.findOneAndUpdate.mockResolvedValueOnce({ id: 'm1', deletedAt: new Date() });

      await deleteMessageFromSession('u1', 's1', 'm1', ability);

      expect(QuestMock.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'm1', sessionId: 's1' },
        { $set: { deletedAt: expect.any(Date) } }
      );
    });
  });

  describe('stopReply', () => {
    it('marks the latest quest as stopped', async () => {
      QuestMock.findOne.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue({ id: 'q9', status: 'running' }) });
      SessionMock.findOne.mockResolvedValueOnce({ id: 's1' });
      QuestMock.findOneAndUpdate.mockResolvedValueOnce({ id: 'q9', status: 'stopped' });

      const result = await stopReply('s1', ability);

      expect(QuestMock.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'q9' },
        { status: 'stopped', statusMessage: 'Generation cancelled by user' },
        { new: true }
      );
      expect(result).toMatchObject({ status: 'stopped' });
    });

    it('is a no-op update when the latest quest is already stopped', async () => {
      QuestMock.findOne.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue({ id: 'q9', status: 'stopped' }) });
      SessionMock.findOne.mockResolvedValueOnce({ id: 's1' });

      const result = await stopReply('s1', ability);

      expect(QuestMock.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'stopped' });
    });

    it('throws when there is no active quest', async () => {
      QuestMock.findOne.mockReturnValueOnce({ sort: vi.fn().mockResolvedValue(null) });
      SessionMock.findOne.mockResolvedValueOnce({ id: 's1' });
      await expect(stopReply('s1', ability)).rejects.toThrow('No active quest found');
    });
  });

  describe('forkSession', () => {
    it('creates a "Forked" session and copies messages up to the fork point', async () => {
      const newSession = { id: 'fork-1', save: vi.fn().mockResolvedValue(undefined) };
      SessionMock.findById.mockResolvedValueOnce({ userId: 'u1', name: 'Orig', knowledgeIds: ['k'], tags: ['t'] });
      QuestMock.findById.mockResolvedValueOnce({ timestamp: new Date(10) });
      createSessionMock.mockResolvedValueOnce(newSession);
      QuestMock.find.mockResolvedValueOnce([{ toObject: () => ({ _id: 'm1', id: 'm1', prompt: 'one' }) }]);
      // addMessageToSession internals
      SessionMock.findOne.mockResolvedValue({ id: 'fork-1', lastUpdated: new Date(0) });
      QuestMock.create.mockResolvedValue({ id: 'copied' });

      const result = await forkSession('s1', 'm1', ability);

      expect(createSessionMock).toHaveBeenCalledWith('u1', { name: 'Forked Orig' }, ability);
      expect(QuestMock.find).toHaveBeenCalledWith({ sessionId: 's1', timestamp: { $lte: expect.any(Date) } });
      // the single source message is re-created on the new session, without _id/id
      expect(QuestMock.create).toHaveBeenCalledWith({ prompt: 'one', sessionId: 'fork-1' });
      expect(result).toBe(newSession);
    });

    it('throws when the source message is missing', async () => {
      SessionMock.findById.mockResolvedValueOnce({ userId: 'u1', name: 'Orig' });
      QuestMock.findById.mockResolvedValueOnce(null);
      await expect(forkSession('s1', 'missing', ability)).rejects.toThrow('Message not found');
    });
  });

  describe('snipSession', () => {
    it('copies messages from the snip point forward', async () => {
      const newSession = { id: 'snip-1', save: vi.fn().mockResolvedValue(undefined) };
      SessionMock.findById.mockResolvedValueOnce({ userId: 'u1', name: 'Orig' });
      QuestMock.findById.mockResolvedValueOnce({ timestamp: new Date(10) });
      createSessionMock.mockResolvedValueOnce(newSession);
      QuestMock.find.mockResolvedValueOnce([]);

      await snipSession('s1', 'm1', ability);

      expect(createSessionMock).toHaveBeenCalledWith('u1', { name: 'Snipped Orig' }, ability);
      expect(QuestMock.find).toHaveBeenCalledWith({ sessionId: 's1', timestamp: { $gte: expect.any(Date) } });
    });
  });

  describe('cloneSession', () => {
    it('rejects when the ability lacks the clone permission', async () => {
      const denyAbility = mockAbility(false);
      await expect(cloneSession('s1', 'admin-1', denyAbility)).rejects.toThrow(
        'User does not have permission to clone sessions'
      );
    });

    it('clones the session under the admin user and copies all messages', async () => {
      const newSession = { id: 'clone-1', save: vi.fn().mockResolvedValue(undefined) };
      SessionMock.findById.mockResolvedValueOnce({ name: 'Orig', knowledgeIds: ['k'], tags: ['t'] });
      createSessionMock.mockResolvedValueOnce(newSession);
      QuestMock.find.mockResolvedValueOnce([{ toObject: () => ({ _id: 'm1', id: 'm1', prompt: 'x' }) }]);
      SessionMock.findOne.mockResolvedValue({ id: 'clone-1', lastUpdated: new Date(0) });
      QuestMock.create.mockResolvedValue({ id: 'copied' });

      const result = await cloneSession('s1', 'admin-1', ability);

      expect(createSessionMock).toHaveBeenCalledWith('admin-1', { name: 'Cloned Orig', knowledgeIds: ['k'] }, ability);
      expect(QuestMock.create).toHaveBeenCalledWith({ prompt: 'x', sessionId: 'clone-1' });
      expect(result).toBe(newSession);
    });
  });

  describe('summarization triggers', () => {
    it('summarizeSession delegates to publishSummarizeSession', async () => {
      await summarizeSession('s1', 'manual');
      expect(publishSummarizeSession).toHaveBeenCalledWith('s1', 'manual');
    });

    it('contextSummarizeSession delegates to publishContextSummarizeSession', async () => {
      await contextSummarizeSession('s1', 'quest-9');
      expect(publishContextSummarizeSession).toHaveBeenCalledWith('s1', 'quest-9');
    });
  });
});
