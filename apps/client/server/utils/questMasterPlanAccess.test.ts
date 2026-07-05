import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { verifyQuestPlanWriteAccess, isValidObjectId, QUEST_ID_PATTERN } from './questMasterPlanAccess';

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockSessionFindById = vi.fn();

vi.mock('@bike4mind/database', () => ({
  questMasterPlanRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  sessionRepository: {
    findById: (...args: unknown[]) => mockSessionFindById(...args),
  },
}));

describe('questMasterPlanAccess', () => {
  const validUserId = new Types.ObjectId().toString();
  const validPlanId = new Types.ObjectId().toString();
  const validNotebookId = new Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidObjectId', () => {
    it('accepts valid ObjectId strings', () => {
      expect(isValidObjectId(new Types.ObjectId().toString())).toBe(true);
    });

    it('rejects invalid strings', () => {
      expect(isValidObjectId('not-an-id')).toBe(false);
      expect(isValidObjectId('')).toBe(false);
      expect(isValidObjectId('123')).toBe(false);
    });
  });

  describe('QUEST_ID_PATTERN', () => {
    it('matches valid quest IDs', () => {
      expect(QUEST_ID_PATTERN.test('quest-1')).toBe(true);
      expect(QUEST_ID_PATTERN.test('sub_quest.2')).toBe(true);
      expect(QUEST_ID_PATTERN.test('ABC123')).toBe(true);
    });

    it('rejects invalid quest IDs', () => {
      expect(QUEST_ID_PATTERN.test('quest 1')).toBe(false);
      expect(QUEST_ID_PATTERN.test('quest<script>')).toBe(false);
      expect(QUEST_ID_PATTERN.test('')).toBe(false);
    });
  });

  describe('verifyQuestPlanWriteAccess', () => {
    it('throws UnauthorizedError when userId is undefined', async () => {
      await expect(verifyQuestPlanWriteAccess(undefined, validPlanId)).rejects.toThrow(UnauthorizedError);
    });

    it('throws BadRequestError for invalid planId format', async () => {
      await expect(verifyQuestPlanWriteAccess(validUserId, 'bad-id')).rejects.toThrow(BadRequestError);
    });

    it('throws NotFoundError when plan does not exist', async () => {
      mockFindById.mockResolvedValue(null);

      await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(NotFoundError);
    });

    it('grants access to plan owner', async () => {
      const plan = { userId: validUserId, sharedWith: [] };
      mockFindById.mockResolvedValue(plan);

      const result = await verifyQuestPlanWriteAccess(validUserId, validPlanId);

      expect(result).toBe(plan);
    });

    it('grants access to shared collaborator', async () => {
      const ownerId = new Types.ObjectId().toString();
      const plan = { userId: ownerId, sharedWith: [validUserId] };
      mockFindById.mockResolvedValue(plan);

      const result = await verifyQuestPlanWriteAccess(validUserId, validPlanId);

      expect(result).toBe(plan);
    });

    it('throws ForbiddenError when user is not owner or shared', async () => {
      const ownerId = new Types.ObjectId().toString();
      const plan = { userId: ownerId, sharedWith: [] };
      mockFindById.mockResolvedValue(plan);

      await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when sharedWith is undefined', async () => {
      const ownerId = new Types.ObjectId().toString();
      const plan = { userId: ownerId };
      mockFindById.mockResolvedValue(plan);

      await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(ForbiddenError);
    });

    describe('legacy backfill', () => {
      it('backfills userId from session ownership and grants access', async () => {
        const plan = { userId: undefined, notebookId: validNotebookId, sharedWith: [] };
        const session = { userId: validUserId };
        mockFindById.mockResolvedValue(plan);
        mockSessionFindById.mockResolvedValue(session);
        mockUpdate.mockResolvedValue(undefined);

        const result = await verifyQuestPlanWriteAccess(validUserId, validPlanId);

        expect(result).toBe(plan);
        expect(plan.userId).toBe(validUserId);
        expect(mockUpdate).toHaveBeenCalledWith(plan);
      });

      it('denies access when session owner does not match', async () => {
        const differentUser = new Types.ObjectId().toString();
        const plan = { userId: undefined, notebookId: validNotebookId };
        const session = { userId: differentUser };
        mockFindById.mockResolvedValue(plan);
        mockSessionFindById.mockResolvedValue(session);

        await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(ForbiddenError);
        expect(mockUpdate).not.toHaveBeenCalled();
      });

      it('denies access when session is not found', async () => {
        const plan = { userId: undefined, notebookId: validNotebookId };
        mockFindById.mockResolvedValue(plan);
        mockSessionFindById.mockResolvedValue(null);

        await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(ForbiddenError);
      });

      it('denies access when notebookId is not a valid ObjectId', async () => {
        const plan = { userId: undefined, notebookId: 'not-valid' };
        mockFindById.mockResolvedValue(plan);

        await expect(verifyQuestPlanWriteAccess(validUserId, validPlanId)).rejects.toThrow(ForbiddenError);
        expect(mockSessionFindById).not.toHaveBeenCalled();
      });
    });
  });
});
