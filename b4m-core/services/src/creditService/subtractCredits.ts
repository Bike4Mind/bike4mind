import {
  CompletionApiUsageTransaction,
  GenericCreditDeductTransaction,
  ICreditHolder,
  ICreditHolderMethods,
  ICreditTransactionRepository,
  ImageEditUsageTransaction,
  ImageGenerationUsageTransaction,
  VideoGenerationUsageTransaction,
  RealtimeVoiceUsageTransaction,
  SpeechToTextUsageTransaction,
  TextToSpeechUsageTransaction,
  TextGenerationUsageTransaction,
  ToolUsageTransaction,
  TransferCreditTransaction,
} from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export interface SubtractCreditsAdapters {
  db: {
    creditTransactions: ICreditTransactionRepository;
  };
  creditHolderMethods: ICreditHolderMethods;
  /**
   * If true, skip the balance update (incrementCredits call).
   * Use this when the balance has already been adjusted atomically (e.g., reservation pattern).
   * The transaction record will still be created.
   * When skipBalanceUpdate is true, you must provide currentCreditHolder.
   */
  skipBalanceUpdate?: boolean;
  /**
   * The current credit holder entity, required when skipBalanceUpdate is true.
   * This is returned as the result instead of fetching from the database.
   */
  currentCreditHolder?: ICreditHolder;
}

/**
 * Discriminated union for subtracting credits (usage tracking)
 *
 * IMPORTANT: When adding a new transaction type, you MUST also update:
 * 1. Add the transaction schema to this discriminated union
 * 2. Add a handler in the switch statement below in subtractCredits()
 * 3. Update packages/database/src/models/CreditTransactionModel.ts - Add to enum and fields
 * 4. Update b4m-core/common/src/types/entities/CreditTransactionTypes.ts
 */
export const SubtractCreditsSchema = z.discriminatedUnion('type', [
  GenericCreditDeductTransaction.omit({ createdAt: true, updatedAt: true }),
  TextGenerationUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  ImageGenerationUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  VideoGenerationUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  RealtimeVoiceUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  ImageEditUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  ToolUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  CompletionApiUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  SpeechToTextUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  TextToSpeechUsageTransaction.omit({ createdAt: true, updatedAt: true }),
  TransferCreditTransaction.omit({ createdAt: true, updatedAt: true }),
]);

export type SubtractCreditsParameters = z.infer<typeof SubtractCreditsSchema>;

/**
 * Subtract credits from a User or Organization and create a corresponding usage transaction record
 */
export async function subtractCredits(
  parameters: SubtractCreditsParameters,
  { db, creditHolderMethods, skipBalanceUpdate, currentCreditHolder }: SubtractCreditsAdapters
): Promise<ICreditHolder> {
  const params = secureParameters(parameters, SubtractCreditsSchema);
  const { ownerId, ownerType, credits, type, description, metadata, source } = params;

  // Validate the reservation-pattern precondition up front (before any DB write).
  if (skipBalanceUpdate && !currentCreditHolder) {
    throw new BadRequestError('currentCreditHolder is required when skipBalanceUpdate is true');
  }

  // Write the usage transaction record FIRST. Its unique keys (stripeDisputeId,
  // stripeRefundId) are the idempotency gate - a duplicate insert throws E11000
  // here, before the balance is decremented, so a retried webhook can never
  // over-claw-back. Callers catch the E11000 and treat it as a no-op.
  // When adding a new transaction type, add a handler here

  if (type === 'generic_deduct') {
    await db.creditTransactions.createTransaction('generic_deduct', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Generic credit deduction',
      metadata,
      source,
      reason: params.reason,
      stripeDisputeId: params.stripeDisputeId,
      stripeRefundId: params.stripeRefundId,
      // Backward compatibility
      userId: params.userId,
    });
  } else if (type === 'text_generation_usage') {
    await db.creditTransactions.createTransaction('text_generation_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Text generation usage',
      metadata,
      source,
      model: params.model,
      questId: params.questId,
      sessionId: params.sessionId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    });
  } else if (type === 'completion_api_usage') {
    await db.creditTransactions.createTransaction('completion_api_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Completion API usage',
      metadata,
      source,
      model: params.model,
      apiKeyId: params.apiKeyId, // Optional - present for API key auth, undefined for JWT
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    });
  } else if (type === 'image_generation_usage') {
    await db.creditTransactions.createTransaction('image_generation_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Image generation usage',
      metadata,
      source,
      model: params.model,
      questId: params.questId,
      sessionId: params.sessionId,
    });
  } else if (type === 'image_edit_usage') {
    await db.creditTransactions.createTransaction('image_edit_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Image editing usage',
      metadata,
      source,
      model: params.model,
      questId: params.questId,
      sessionId: params.sessionId,
    });
  } else if (type === 'video_generation_usage') {
    await db.creditTransactions.createTransaction('video_generation_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Video generation usage',
      metadata,
      source,
      model: params.model,
      questId: params.questId,
      sessionId: params.sessionId,
    });
  } else if (type === 'tool_usage') {
    await db.creditTransactions.createTransaction('tool_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits),
      description: description || 'Tool usage',
      metadata,
      source,
      model: params.model,
      questId: params.questId,
      sessionId: params.sessionId,
    });
  } else if (type === 'speech_to_text_usage') {
    await db.creditTransactions.createTransaction('speech_to_text_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits),
      description: description || 'Speech to text usage',
      metadata,
      source,
      model: params.model,
      sessionId: params.sessionId,
    });
  } else if (type === 'text_to_speech_usage') {
    await db.creditTransactions.createTransaction('text_to_speech_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits),
      description: description || 'Text to speech usage',
      metadata,
      source,
      model: params.model,
      sessionId: params.sessionId,
    });
  } else if (type === 'transfer_credit') {
    await db.creditTransactions.createTransaction('transfer_credit', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Transfer credits',
      source,
      recipientId: params.recipientId,
      recipientType: params.recipientType,
    });
  } else {
    await db.creditTransactions.createTransaction('realtime_voice_usage', {
      ownerId,
      ownerType,
      credits: -Math.abs(credits), // Negative for usage
      description: description || 'Voice usage',
      metadata,
      source,
      model: params.model,
      sessionId: params.sessionId,
    });
  }

  // Transaction record committed - now decrement the balance exactly once,
  // unless it was already adjusted atomically via the reservation pattern.
  if (skipBalanceUpdate) {
    // currentCreditHolder is guaranteed present by the precondition check above.
    if (!currentCreditHolder) {
      throw new BadRequestError('currentCreditHolder is required when skipBalanceUpdate is true');
    }
    return currentCreditHolder;
  }

  const updatedEntity = await creditHolderMethods.incrementCredits(ownerId, -credits);
  if (!updatedEntity) {
    throw new BadRequestError('Failed to update credits');
  }

  return updatedEntity;
}
