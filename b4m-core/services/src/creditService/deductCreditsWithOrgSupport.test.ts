import { describe, it, expect, vi, beforeEach, MockedObject } from 'vitest';
import { deductCreditsWithOrgSupport, DeductCreditsAdapters, DeductCreditsParams } from './deductCreditsWithOrgSupport';
import {
  CreditHolderType,
  ICreditHolder,
  ICreditHolderMethods,
  IOrganizationDocument,
  IUserDocument,
} from '@bike4mind/common';
import { createMockCreditTransactionRepository, createMockOrganizationRepository } from '../__tests__/utils/testUtils';

// Mock subtractCredits to isolate unit tests
vi.mock('./subtractCredits', () => ({
  subtractCredits: vi.fn().mockResolvedValue(undefined),
}));

import { subtractCredits } from './subtractCredits';

const mockSubtractCredits = vi.mocked(subtractCredits);

describe('creditService - deductCreditsWithOrgSupport', () => {
  const mockUser = {
    id: 'user1',
    currentCredits: 100,
  } as IUserDocument;

  const mockOrganization = {
    id: 'org1',
    currentCredits: 500,
    userDetails: [
      { id: 'user1', name: 'Test User', usedCredits: 50, lastCreditUsedAt: null },
      { id: 'user2', name: 'Other User', usedCredits: 20, lastCreditUsedAt: null },
    ],
  } as unknown as IOrganizationDocument;

  let mockAdapters: DeductCreditsAdapters;
  let mockUserCreditHolderMethods: MockedObject<ICreditHolderMethods>;
  let mockOrgRepo: ReturnType<typeof createMockOrganizationRepository>;
  let mockCreditTransactionRepo: ReturnType<typeof createMockCreditTransactionRepository>;

  beforeEach(() => {
    vi.resetAllMocks();

    mockUserCreditHolderMethods = vi.mocked({
      incrementCredits: vi.fn().mockResolvedValue(mockUser),
    });
    mockOrgRepo = createMockOrganizationRepository();
    mockOrgRepo.incrementCredits.mockResolvedValue(mockOrganization as unknown as ICreditHolder);
    mockCreditTransactionRepo = createMockCreditTransactionRepository();

    mockAdapters = {
      db: {
        creditTransactions: mockCreditTransactionRepo,
        users: mockUserCreditHolderMethods,
        organizations: mockOrgRepo,
      },
    };
  });

  describe('user-only deduction (no organization)', () => {
    it('should deduct credits from user when no organization is present', async () => {
      const params: DeductCreditsParams = {
        type: 'text_generation_usage',
        user: mockUser,
        organization: null,
        credits: 25,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'claude-3-sonnet',
        inputTokens: 1000,
        outputTokens: 500,
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockOrgRepo.updateUserDetails).not.toHaveBeenCalled();
      // Pin the FULL arg shape on at least one case so extra/unexpected params
      // don't pass silently. Other cases below use `objectContaining` to focus
      // on the field under test.
      expect(mockSubtractCredits).toHaveBeenCalledWith(
        {
          type: 'text_generation_usage',
          ownerId: 'user1',
          ownerType: CreditHolderType.User,
          credits: 25,
          sessionId: 'session1',
          questId: 'quest1',
          model: 'claude-3-sonnet',
          inputTokens: 1000,
          outputTokens: 500,
          // Defaults to 'web' when not supplied - web chat is the dominant
          // caller of this helper.
          source: 'web',
        },
        {
          db: { creditTransactions: mockCreditTransactionRepo },
          creditHolderMethods: mockUserCreditHolderMethods,
          skipBalanceUpdate: undefined,
          currentCreditHolder: undefined,
        }
      );
    });

    it('should handle undefined organization the same as null', async () => {
      const params: DeductCreditsParams = {
        type: 'image_generation_usage',
        user: mockUser,
        organization: undefined,
        credits: 100,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'dall-e-3',
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockOrgRepo.updateUserDetails).not.toHaveBeenCalled();
      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'user1',
          ownerType: CreditHolderType.User,
        }),
        expect.objectContaining({
          creditHolderMethods: mockUserCreditHolderMethods,
        })
      );
    });
  });

  describe('organization deduction', () => {
    it('should deduct credits from organization and update userDetails atomically', async () => {
      const params: DeductCreditsParams = {
        type: 'text_generation_usage',
        user: mockUser,
        organization: mockOrganization,
        credits: 30,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'claude-3-sonnet',
        inputTokens: 800,
        outputTokens: 200,
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      // Should use $inc (creditsDelta) for atomic increment, not $set with computed value
      expect(mockOrgRepo.updateUserDetails).toHaveBeenCalledWith('org1', 'user1', {
        creditsDelta: 30,
        lastCreditUsedAt: expect.any(Date),
      });

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text_generation_usage',
          ownerId: 'org1',
          ownerType: CreditHolderType.Organization,
          credits: 30,
          sessionId: 'session1',
          questId: 'quest1',
          model: 'claude-3-sonnet',
          inputTokens: 800,
          outputTokens: 200,
          source: 'web',
        }),
        expect.objectContaining({
          db: { creditTransactions: mockCreditTransactionRepo },
          creditHolderMethods: mockOrgRepo,
        })
      );
    });

    it('should call updateUserDetails even when user has no existing entry (repo handles warning)', async () => {
      const orgWithoutUser = {
        id: 'org1',
        currentCredits: 500,
        userDetails: [{ id: 'other-user', name: 'Other', usedCredits: 10, lastCreditUsedAt: null }],
      } as unknown as IOrganizationDocument;

      const params: DeductCreditsParams = {
        type: 'image_generation_usage',
        user: mockUser,
        organization: orgWithoutUser,
        credits: 50,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'dall-e-3',
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      // Should still call updateUserDetails - the repo layer handles the no-match warning
      expect(mockOrgRepo.updateUserDetails).toHaveBeenCalledWith('org1', 'user1', {
        creditsDelta: 50,
        lastCreditUsedAt: expect.any(Date),
      });
    });
  });

  describe('transaction type handling', () => {
    it('should pass inputTokens and outputTokens for text_generation_usage', async () => {
      const params: DeductCreditsParams = {
        type: 'text_generation_usage',
        user: mockUser,
        organization: null,
        credits: 15,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'gpt-4',
        inputTokens: 500,
        outputTokens: 250,
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text_generation_usage',
          inputTokens: 500,
          outputTokens: 250,
        }),
        expect.any(Object)
      );
    });

    it('should handle image_generation_usage type', async () => {
      const params: DeductCreditsParams = {
        type: 'image_generation_usage',
        user: mockUser,
        organization: null,
        credits: 100,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'dall-e-3',
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image_generation_usage' }),
        expect.any(Object)
      );
    });

    it('should handle image_edit_usage type', async () => {
      const params: DeductCreditsParams = {
        type: 'image_edit_usage',
        user: mockUser,
        organization: null,
        credits: 75,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'dall-e-2-edit',
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image_edit_usage' }),
        expect.any(Object)
      );
    });

    it('should handle video_generation_usage type', async () => {
      const params: DeductCreditsParams = {
        type: 'video_generation_usage',
        user: mockUser,
        organization: null,
        credits: 200,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'sora',
      };

      await deductCreditsWithOrgSupport(params, mockAdapters);

      expect(mockSubtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video_generation_usage' }),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should propagate errors from updateUserDetails', async () => {
      mockOrgRepo.updateUserDetails.mockRejectedValue(new Error('DB connection failed'));

      const params: DeductCreditsParams = {
        type: 'text_generation_usage',
        user: mockUser,
        organization: mockOrganization,
        credits: 25,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'claude-3-sonnet',
        inputTokens: 100,
        outputTokens: 50,
      };

      await expect(deductCreditsWithOrgSupport(params, mockAdapters)).rejects.toThrow('DB connection failed');

      // subtractCredits should not be called if userDetails update fails
      expect(mockSubtractCredits).not.toHaveBeenCalled();
    });

    it('should propagate errors from subtractCredits', async () => {
      mockSubtractCredits.mockRejectedValue(new Error('Credit deduction failed'));

      const params: DeductCreditsParams = {
        type: 'image_generation_usage',
        user: mockUser,
        organization: null,
        credits: 50,
        sessionId: 'session1',
        questId: 'quest1',
        model: 'dall-e-3',
      };

      await expect(deductCreditsWithOrgSupport(params, mockAdapters)).rejects.toThrow('Credit deduction failed');
    });
  });
});
