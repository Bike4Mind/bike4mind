import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentRepository, userRepository, creditTransactionRepository, withTransaction } from '@bike4mind/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';

const handler = baseApi().post<Request<{}, {}, { amount: number }>>(async (req, res) => {
  const { id } = req.query;
  const { amount } = req.body;

  // Validate input
  if (!amount || amount <= 0) {
    throw new BadRequestError('Invalid transfer amount. Amount must be greater than 0.');
  }

  // Use transaction for atomicity
  await withTransaction(async () => {
    // Get the agent
    const agent = await agentRepository.findById(id as string);
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }

    // Check ownership
    if (agent.userId !== req.user!.id) {
      throw new ForbiddenError("You don't have permission to transfer credits to this agent");
    }

    // Get the user
    const user = await userRepository.findById(req.user!.id);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if user has enough credits
    const userCredits = user.currentCredits || 0;
    if (userCredits < amount) {
      throw new BadRequestError(`Insufficient credits. Your current balance: ${userCredits.toLocaleString()}`);
    }

    // Deduct credits from user (with transaction record)
    const updatedUser = await creditService.subtractCredits(
      {
        type: 'transfer_credit',
        ownerId: req.user!.id,
        ownerType: CreditHolderType.User,
        credits: amount,
        description: `Transfer credits to agent "${agent.name}"`,
        recipientId: id as string,
        recipientType: CreditHolderType.Agent,
      },
      {
        db: {
          creditTransactions: creditTransactionRepository,
        },
        creditHolderMethods: userRepository,
      }
    );

    if (!updatedUser) {
      throw new Error('Failed to update user credits');
    }

    // Add credits to agent (with transaction record)
    const updatedAgent = await creditService.addCredits(
      {
        type: 'received_credit',
        ownerId: id as string,
        ownerType: CreditHolderType.Agent,
        credits: amount,
        description: `Received credits from user`,
        senderId: req.user!.id,
        senderType: CreditHolderType.User,
      },
      {
        db: {
          creditTransactions: creditTransactionRepository,
        },
        creditHolderMethods: agentRepository,
      }
    );

    if (!updatedAgent) {
      throw new Error('Failed to update agent credits');
    }

    // Return success with updated balances
    return res.json({
      success: true,
      message: `Successfully transferred ${amount.toLocaleString()} credits to agent "${agent.name}"`,
      userCredits: updatedUser.currentCredits,
      agentCredits: updatedAgent.currentCredits,
    });
  });
});

export default handler;
