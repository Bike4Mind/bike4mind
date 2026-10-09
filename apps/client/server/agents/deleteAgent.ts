import { agentRepository, User, userRepository, creditTransactionRepository } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';

/**
 * Deletes an agent the caller has already been verified to own: returns its credits to `userId`,
 * deletes it, then best-effort clears it as anyone's custom Slack agent. Shared by
 * DELETE /api/agents/[id] and DELETE /api/v1/agents/[id].
 */
export async function deleteAgent(agent: { id: string }, userId: string): Promise<void> {
  // Reclaim agent credits back to owning user before deletion.
  // claimCredits atomically zeroes the agent balance and returns the claimed amount -
  // concurrent DELETE requests will get 0 on the second call, preventing double credit grant.
  const creditsToReclaim = await agentRepository.claimCredits(agent.id);
  if (creditsToReclaim > 0) {
    try {
      // Credit user first: if subsequent agent debit fails, user has extra credits (recoverable)
      // rather than losing credits permanently (agent debited but user never credited).
      await creditService.addCredits(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: creditsToReclaim,
          type: 'received_credit',
          senderId: agent.id,
          senderType: CreditHolderType.Agent,
          description: 'Credits returned from deleted agent',
        },
        { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
      );
      await creditService.subtractCredits(
        {
          type: 'transfer_credit',
          ownerId: agent.id,
          ownerType: CreditHolderType.Agent,
          credits: creditsToReclaim,
          description: 'Agent credit reclaim on deletion',
          recipientId: userId,
          recipientType: CreditHolderType.User,
        },
        { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: agentRepository }
      );
    } catch (err) {
      // Non-atomic: log for manual reconciliation but still block deletion if reclaim failed
      console.error('Agent credit reclaim failed - manual reconciliation may be needed', {
        agentId: agent.id,
        userId,
        credits: creditsToReclaim,
        err,
      });
      throw err;
    }
  }

  // Delete the agent
  await agentRepository.delete(agent.id);

  // Clean up any users who had this agent selected as their custom Slack agent
  try {
    await User.updateMany(
      { 'slackSettings.customAgentId': agent.id },
      { $unset: { 'slackSettings.customAgentId': '' } }
    );
  } catch (error) {
    console.error('Failed to clean up agent references:', error);
    // Don't fail the request - agent is already deleted
  }
}
