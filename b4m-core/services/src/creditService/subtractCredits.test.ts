import { describe, it, expect, vi, beforeEach, MockedObject } from 'vitest';
import { subtractCredits, SubtractCreditsAdapters, SubtractCreditsParameters } from './subtractCredits';
import { ICreditHolder, ICreditHolderMethods, CreditHolderType } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { createMockCreditTransactionRepository } from '../__tests__/utils/testUtils';

describe('creditService - subtractCredits', () => {
  // Mock credit holder responses
  const mockUser: ICreditHolder = {
    id: 'user1',
    currentCredits: 50,
  } as ICreditHolder;

  const mockOrganization: ICreditHolder = {
    id: 'org1',
    currentCredits: 450,
  } as ICreditHolder;

  // Mock adapters
  let mockAdapters: SubtractCreditsAdapters;
  let mockCreditHolderMethods: MockedObject<ICreditHolderMethods>;
  let mockCreditTransactionRepo: ReturnType<typeof createMockCreditTransactionRepository>;

  beforeEach(() => {
    vi.resetAllMocks();

    mockCreditHolderMethods = vi.mocked({
      incrementCredits: vi.fn(),
    });
    mockCreditTransactionRepo = createMockCreditTransactionRepository();

    mockAdapters = {
      db: {
        creditTransactions: mockCreditTransactionRepo,
      },
      creditHolderMethods: mockCreditHolderMethods,
    };
  });

  describe('generic_deduct transactions', () => {
    it('should subtract credits from user for generic_deduct transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        description: 'Manual deduction',
        reason: 'admin_adjustment',
        metadata: { adminId: 'admin123' },
        userId: 'user1',
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -50);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('generic_deduct', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -50,
        description: 'Manual deduction',
        metadata: { adminId: 'admin123' },
        reason: 'admin_adjustment',
        userId: 'user1',
      });
    });

    it('should subtract credits from organization for generic_deduct transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockOrganization);

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 50,
        reason: 'refund_adjustment',
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockOrganization);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('org1', -50);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('generic_deduct', {
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: -50,
        description: 'Generic credit deduction',
        metadata: undefined,
        reason: 'refund_adjustment',
        userId: undefined,
      });
    });
  });

  describe('text_generation_usage transactions', () => {
    it('should subtract credits for text generation usage', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'text_generation_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 25,
        description: 'Claude chat completion',
        model: 'claude-3-sonnet',
        questId: 'quest123',
        sessionId: 'session456',
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { temperature: 0.7 },
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -25);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('text_generation_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -25,
        description: 'Claude chat completion',
        metadata: { temperature: 0.7 },
        model: 'claude-3-sonnet',
        questId: 'quest123',
        sessionId: 'session456',
        inputTokens: 1000,
        outputTokens: 500,
      });
    });

    it('should use default description for text generation when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'text_generation_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 10,
        model: 'gpt-4',
        questId: 'quest789',
        sessionId: 'session789',
        inputTokens: 500,
        outputTokens: 250,
      };

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'text_generation_usage',
        expect.objectContaining({
          description: 'Text generation usage',
        })
      );
    });
  });

  describe('completion_api_usage transactions', () => {
    it('should forward source field through to createTransaction (CLI/API attribution)', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'completion_api_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 10,
        model: 'claude-3-sonnet',
        apiKeyId: 'apikey-123',
        inputTokens: 200,
        outputTokens: 100,
        source: 'api',
      };

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('completion_api_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -10,
        description: 'Completion API usage',
        metadata: undefined,
        source: 'api',
        model: 'claude-3-sonnet',
        apiKeyId: 'apikey-123',
        inputTokens: 200,
        outputTokens: 100,
      });
    });

    it('should reject an unknown source value at the Zod enum boundary', async () => {
      const parameters = {
        type: 'completion_api_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 10,
        model: 'claude-3-sonnet',
        inputTokens: 200,
        outputTokens: 100,
        // @ts-ignore - intentionally invalid source to verify enum rejects it
        source: 'not-a-real-source',
      } as SubtractCreditsParameters;

      await expect(subtractCredits(parameters, mockAdapters)).rejects.toThrow();
      expect(mockCreditTransactionRepo.createTransaction).not.toHaveBeenCalled();
    });
  });

  describe('image_generation_usage transactions', () => {
    it('should subtract credits for image generation usage', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockOrganization);

      const parameters: SubtractCreditsParameters = {
        type: 'image_generation_usage',
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 100,
        description: 'DALL-E 3 generation',
        model: 'dall-e-3',
        questId: 'quest456',
        sessionId: 'session123',
        metadata: { size: '1024x1024', quality: 'hd' },
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockOrganization);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('org1', -100);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('image_generation_usage', {
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: -100,
        description: 'DALL-E 3 generation',
        metadata: { size: '1024x1024', quality: 'hd' },
        model: 'dall-e-3',
        questId: 'quest456',
        sessionId: 'session123',
      });
    });
  });

  describe('image_edit_usage transactions', () => {
    it('should subtract credits for image editing usage', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'image_edit_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 75,
        model: 'dall-e-2-edit',
        questId: 'quest999',
        sessionId: 'session999',
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -75);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('image_edit_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -75,
        description: 'Image editing usage',
        metadata: undefined,
        model: 'dall-e-2-edit',
        questId: 'quest999',
        sessionId: 'session999',
      });
    });
  });

  describe('tool_usage transactions', () => {
    it('should subtract credits for tool usage', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'tool_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 15,
        model: 'claude-3-sonnet',
        questId: 'quest123',
        sessionId: 'session456',
        metadata: { source: 'chat_tool' },
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -15);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('tool_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -15,
        description: 'Tool usage',
        metadata: { source: 'chat_tool' },
        model: 'claude-3-sonnet',
        questId: 'quest123',
        sessionId: 'session456',
      });
    });

    it('should use default description for tool usage when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'tool_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 10,
        model: 'gpt-4o',
        questId: 'quest789',
        sessionId: 'session789',
      };

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'tool_usage',
        expect.objectContaining({
          description: 'Tool usage',
        })
      );
    });
  });

  describe('realtime_voice_usage transactions', () => {
    it('should subtract credits for realtime voice usage', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'realtime_voice_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        description: 'Voice conversation',
        model: 'gpt-4o-realtime',
        sessionId: 'voice_session_123',
        metadata: { duration: 300, quality: 'high' },
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -50);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('realtime_voice_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -50,
        description: 'Voice conversation',
        metadata: { duration: 300, quality: 'high' },
        model: 'gpt-4o-realtime',
        sessionId: 'voice_session_123',
      });
    });
  });

  describe('transfer_credit transactions', () => {
    it('should subtract credits for transfer_credit transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'transfer_credit',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 30,
        description: 'Transfer to friend',
        recipientId: 'user2',
        recipientType: CreditHolderType.User,
      };

      const result = await subtractCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', -30);
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('transfer_credit', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -30,
        description: 'Transfer to friend',
        recipientId: 'user2',
        recipientType: CreditHolderType.User,
      });
    });

    it('should use default description for transfer_credit when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'transfer_credit',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 25,
        recipientId: 'org1',
        recipientType: CreditHolderType.Organization,
      };

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'transfer_credit',
        expect.objectContaining({
          description: 'Transfer credits',
        })
      );
    });
  });

  describe('idempotency (transaction written before balance decrement)', () => {
    it('writes the transaction record BEFORE decrementing the balance', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        reason: 'refund_clawback',
        stripeRefundId: 're_1',
      };

      await subtractCredits(parameters, mockAdapters);

      const createOrder = mockCreditTransactionRepo.createTransaction.mock.invocationCallOrder[0];
      const decrementOrder = mockCreditHolderMethods.incrementCredits.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(decrementOrder);
    });

    it('does NOT decrement when a duplicate-key E11000 is rethrown (stripeRefundId)', async () => {
      // Duplicate Stripe refund webhook: the unique-key insert throws before the
      // balance is touched, so the user is never clawed back twice.
      mockCreditTransactionRepo.createTransaction.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
          keyPattern: { stripeRefundId: 1 },
        })
      );

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        reason: 'refund_clawback',
        stripeRefundId: 're_dup',
      };

      await expect(subtractCredits(parameters, mockAdapters)).rejects.toMatchObject({ code: 11000 });
      expect(mockCreditHolderMethods.incrementCredits).not.toHaveBeenCalled();
    });

    it('skipBalanceUpdate: creates the transaction, never decrements, returns currentCreditHolder', async () => {
      const parameters: SubtractCreditsParameters = {
        type: 'realtime_voice_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 20,
        model: 'gpt-4o-realtime',
        sessionId: 'voice_1',
      };

      const result = await subtractCredits(parameters, {
        ...mockAdapters,
        skipBalanceUpdate: true,
        currentCreditHolder: mockUser,
      });

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).not.toHaveBeenCalled();
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'realtime_voice_usage',
        expect.objectContaining({ credits: -20 })
      );
    });
  });

  describe('error handling', () => {
    it('should throw BadRequestError when credit update fails', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(null);

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'nonexistent',
        ownerType: CreditHolderType.User,
        credits: 50,
        reason: 'manual',
      };

      await expect(subtractCredits(parameters, mockAdapters)).rejects.toThrow(
        new BadRequestError('Failed to update credits')
      );
    });

    it('should handle database errors gracefully', async () => {
      mockCreditHolderMethods.incrementCredits.mockRejectedValue(new Error('Database connection failed'));

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        reason: 'manual',
      };

      await expect(subtractCredits(parameters, mockAdapters)).rejects.toThrow('Database connection failed');
    });

    it('should handle transaction creation errors', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);
      mockCreditTransactionRepo.createTransaction.mockRejectedValue(new Error('Transaction creation failed'));

      const parameters: SubtractCreditsParameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        reason: 'manual',
      };

      await expect(subtractCredits(parameters, mockAdapters)).rejects.toThrow('Transaction creation failed');
    });
  });

  describe('parameter validation', () => {
    it('should validate and secure parameters using Zod schema', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters = {
        type: 'generic_deduct',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 25,
        reason: 'manual',
        // @ts-ignore - Adding extra parameter to test validation
        extraField: 'should be ignored',
      } as SubtractCreditsParameters;

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'generic_deduct',
        expect.not.objectContaining({
          extraField: 'should be ignored',
        })
      );
    });

    it('should handle metadata correctly for all transaction types', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const metadata = {
        source: 'api',
        requestId: 'req123',
        userAgent: 'TestClient/1.0',
      };

      const parameters: SubtractCreditsParameters = {
        type: 'text_generation_usage',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 15,
        model: 'claude-3-haiku',
        questId: 'quest111',
        sessionId: 'session222',
        inputTokens: 100,
        outputTokens: 50,
        metadata,
      };

      await subtractCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('text_generation_usage', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: -15,
        description: 'Text generation usage',
        metadata,
        model: 'claude-3-haiku',
        questId: 'quest111',
        sessionId: 'session222',
        inputTokens: 100,
        outputTokens: 50,
      });
    });
  });
});
