import { agentRepository, userRepository, creditTransactionRepository, withTransaction } from '@bike4mind/database';
import { NotFoundError, BadRequestError } from '@bike4mind/utils';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { assertAgentAccess } from '@server/agents/assertAgentAccess';

/** The caller's balance is below the amount. A 400 on the SPA route; the v1 route reports it as a 422. */
export class InsufficientTransferBalanceError extends BadRequestError {
  constructor(public readonly balance: number) {
    super(`Insufficient credits. Your current balance: ${balance.toLocaleString()}`);
  }
}

export type TransferCreditsResult = {
  agentName: string;
  userCredits: number;
  agentCredits: number;
};

/**
 * Moves `amount` credits from the caller to an agent they own, as one transaction with a ledger
 * entry on each side. The caller validates that `amount` is positive.
 */
export async function transferCreditsToAgent(
  agentId: string,
  userId: string,
  amount: number
): Promise<TransferCreditsResult> {
  return withTransaction(async () => {
    const agent = await agentRepository.findById(agentId);
    assertAgentAccess(agent, userId, 'own', "You don't have permission to transfer credits to this agent");

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const userCredits = user.currentCredits || 0;
    if (userCredits < amount) {
      throw new InsufficientTransferBalanceError(userCredits);
    }

    const updatedUser = await creditService.subtractCredits(
      {
        type: 'transfer_credit',
        ownerId: userId,
        ownerType: CreditHolderType.User,
        credits: amount,
        description: `Transfer credits to agent "${agent.name}"`,
        recipientId: agentId,
        recipientType: CreditHolderType.Agent,
      },
      { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
    );
    if (!updatedUser) {
      throw new Error('Failed to update user credits');
    }

    const updatedAgent = await creditService.addCredits(
      {
        type: 'received_credit',
        ownerId: agentId,
        ownerType: CreditHolderType.Agent,
        credits: amount,
        description: 'Received credits from user',
        senderId: userId,
        senderType: CreditHolderType.User,
      },
      { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: agentRepository }
    );
    if (!updatedAgent) {
      throw new Error('Failed to update agent credits');
    }

    return {
      agentName: agent.name,
      userCredits: updatedUser.currentCredits,
      agentCredits: updatedAgent.currentCredits,
    };
  });
}
