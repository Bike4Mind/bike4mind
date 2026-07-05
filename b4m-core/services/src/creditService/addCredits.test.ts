import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addCredits, AddCreditsAdapters, AddCreditsParameters } from './addCredits';
import { ICreditHolder, ICreditHolderMethods, CreditHolderType, CreditPurchaseStatus } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { createMockCreditTransactionRepository } from '../__tests__/utils/testUtils';
import { MockedObject } from 'vitest';

describe('creditService - addCredits', () => {
  // Mock credit holder responses
  const mockUser: ICreditHolder = {
    id: 'user1',
    currentCredits: 200,
  } as ICreditHolder;

  const mockOrganization: ICreditHolder = {
    id: 'org1',
    currentCredits: 600,
  } as ICreditHolder;

  // Mock adapters
  let mockAdapters: AddCreditsAdapters;
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

  describe('purchase transactions', () => {
    it('should add credits to user for purchase transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'purchase',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        description: 'Credit purchase',
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_123',
        packageId: 'pkg_123',
        amount: 1000,
        userId: 'user1',
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', 100, {
        updateLastCreditsPurchasedAt: true,
      });
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('purchase', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        description: 'Credit purchase',
        metadata: undefined,
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_123',
        packageId: 'pkg_123',
        amount: 1000,
        userId: 'user1',
      });
    });

    it('should add credits to organization for purchase transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockOrganization);

      const parameters: AddCreditsParameters = {
        type: 'purchase',
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 100,
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_456',
        packageId: 'pkg_456',
        amount: 1000,
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockOrganization);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('org1', 100, {
        updateLastCreditsPurchasedAt: true,
      });
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('purchase', {
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 100,
        description: 'Credit purchase',
        metadata: undefined,
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_456',
        packageId: 'pkg_456',
        amount: 1000,
        userId: undefined,
      });
    });

    it('should throw BadRequestError when credit update fails', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(null);

      const parameters: AddCreditsParameters = {
        type: 'purchase',
        ownerId: 'nonexistent',
        ownerType: CreditHolderType.User,
        credits: 100,
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_123',
        packageId: 'pkg_123',
        amount: 1000,
      };

      await expect(addCredits(parameters, mockAdapters)).rejects.toThrow(
        new BadRequestError('Failed to update credits')
      );
    });
  });

  describe('subscription transactions', () => {
    it('should add credits to user for subscription transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'subscription',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 150,
        description: 'Monthly subscription credits',
        metadata: { subscriptionId: 'sub_123' },
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', 150, {
        updateLastCreditsPurchasedAt: false,
      });
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('subscription', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 150,
        description: 'Monthly subscription credits',
        metadata: { subscriptionId: 'sub_123' },
      });
    });

    it('should use default description for subscription when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'subscription',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
      };

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('subscription', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        description: 'Subscription credit allocation',
        metadata: undefined,
      });
    });
  });

  describe('generic_add transactions', () => {
    it('should add credits to user for generic_add transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        description: 'Admin credit bonus',
        reason: 'customer_support',
        metadata: { adminId: 'admin123' },
        userId: 'user1',
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', 50, {
        updateLastCreditsPurchasedAt: false,
      });
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('generic_add', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        description: 'Admin credit bonus',
        metadata: { adminId: 'admin123' },
        reason: 'customer_support',
        userId: 'user1',
      });
    });

    it('should use default description for generic_add when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 25,
        reason: 'promotion',
      };

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('generic_add', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 25,
        description: 'Generic credit addition',
        metadata: undefined,
        reason: 'promotion',
        userId: undefined,
      });
    });

    it('should pass transactionId to createTransaction for Zod passthrough verification', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        transactionId: 'completion-refund:run-abc-123',
      };

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'generic_add',
        expect.objectContaining({ transactionId: 'completion-refund:run-abc-123' })
      );
    });
  });

  describe('received_credit transactions', () => {
    it('should add credits to user for received_credit transaction', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'received_credit',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 75,
        description: 'Credits from friend',
        senderId: 'user2',
        senderType: CreditHolderType.User,
        metadata: { transferId: 'transfer123' },
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', 75, {
        updateLastCreditsPurchasedAt: false,
      });
      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('received_credit', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 75,
        description: 'Credits from friend',
        metadata: { transferId: 'transfer123' },
        senderId: 'user2',
        senderType: CreditHolderType.User,
      });
    });

    it('should use default description for received_credit when not provided', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'received_credit',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        senderId: 'org1',
        senderType: CreditHolderType.Organization,
      };

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('received_credit', {
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        description: 'Received credit',
        metadata: undefined,
        senderId: 'org1',
        senderType: CreditHolderType.Organization,
      });
    });
  });

  describe('parameter validation', () => {
    it('should validate and secure parameters using Zod schema', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters = {
        type: 'subscription',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
        // @ts-ignore - Adding extra parameter to test validation
        extraField: 'should be ignored',
      } as AddCreditsParameters;

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith(
        'subscription',
        expect.not.objectContaining({
          extraField: 'should be ignored',
        })
      );
    });

    it('should handle metadata correctly', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockOrganization);

      const metadata = {
        source: 'api',
        campaignId: 'camp123',
        notes: 'Promotional credits',
      };

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 100,
        reason: 'promotion',
        metadata,
      };

      await addCredits(parameters, mockAdapters);

      expect(mockCreditTransactionRepo.createTransaction).toHaveBeenCalledWith('generic_add', {
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        credits: 100,
        description: 'Generic credit addition',
        metadata,
        reason: 'promotion',
        userId: undefined,
      });
    });
  });

  describe('idempotency (transaction written before balance increment)', () => {
    it('writes the transaction record BEFORE incrementing the balance', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        transactionId: 'reservation-refund:run-1',
      };

      await addCredits(parameters, mockAdapters);

      const createOrder = mockCreditTransactionRepo.createTransaction.mock.invocationCallOrder[0];
      const incrementOrder = mockCreditHolderMethods.incrementCredits.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(incrementOrder);
    });

    it('does not credit the balance on a duplicate transactionId (createTransaction returns null)', async () => {
      // Repo swallows the E11000 on transactionId and returns null for the dup.
      // The dup path fetches the holder via a net-zero increment - never the real amount.
      mockCreditTransactionRepo.createTransaction.mockResolvedValue(null);
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        transactionId: 'reservation-refund:run-1',
      };

      const result = await addCredits(parameters, mockAdapters);

      expect(result).toEqual(mockUser);
      // Balance untouched: increment called with 0, never with the credit amount.
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledTimes(1);
      expect(mockCreditHolderMethods.incrementCredits).toHaveBeenCalledWith('user1', 0);
      expect(mockCreditHolderMethods.incrementCredits).not.toHaveBeenCalledWith('user1', 100, expect.anything());
    });

    it('does NOT increment when a non-transactionId E11000 is rethrown (e.g. stripePaymentIntentId)', async () => {
      mockCreditTransactionRepo.createTransaction.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
          keyPattern: { stripePaymentIntentId: 1 },
        })
      );

      const parameters: AddCreditsParameters = {
        type: 'purchase',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 100,
        status: CreditPurchaseStatus.Completed,
        stripePaymentIntentId: 'pi_dup',
        packageId: 'pkg_1',
        amount: 1000,
      };

      await expect(addCredits(parameters, mockAdapters)).rejects.toMatchObject({ code: 11000 });
      expect(mockCreditHolderMethods.incrementCredits).not.toHaveBeenCalled();
    });

    it('throws if the holder cannot be loaded on the idempotent dup path', async () => {
      mockCreditTransactionRepo.createTransaction.mockResolvedValue(null);
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(null);

      const parameters: AddCreditsParameters = {
        type: 'generic_add',
        ownerId: 'ghost',
        ownerType: CreditHolderType.User,
        credits: 100,
        transactionId: 'reservation-refund:run-2',
      };

      await expect(addCredits(parameters, mockAdapters)).rejects.toThrow(BadRequestError);
      // Only the net-zero fetch was attempted; the real credit amount was never applied.
      expect(mockCreditHolderMethods.incrementCredits).not.toHaveBeenCalledWith('ghost', 100, expect.anything());
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);
      mockCreditTransactionRepo.createTransaction.mockRejectedValue(new Error('Database connection failed'));

      const parameters: AddCreditsParameters = {
        type: 'subscription',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
      };

      await expect(addCredits(parameters, mockAdapters)).rejects.toThrow('Database connection failed');
    });

    it('should handle transaction creation errors', async () => {
      mockCreditHolderMethods.incrementCredits.mockResolvedValue(mockUser);
      mockCreditTransactionRepo.createTransaction.mockRejectedValue(new Error('Transaction creation failed'));

      const parameters: AddCreditsParameters = {
        type: 'subscription',
        ownerId: 'user1',
        ownerType: CreditHolderType.User,
        credits: 50,
      };

      await expect(addCredits(parameters, mockAdapters)).rejects.toThrow('Transaction creation failed');
    });
  });
});
