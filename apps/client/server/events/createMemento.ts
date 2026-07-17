import { withEventContext } from '@server/events/utils';
import { LLMEvents } from '@server/utils/eventBus';
import { apiKeyRepository, adminSettingsRepository, Memento } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { ChatModels, MementoTier, MementoType } from '@bike4mind/common';
import { apiKeyService, MementoEvaluationService, mementoService } from '@bike4mind/services';
import { generateMementoSummaryEmbedding } from '@server/utils/mementoEmbedding';

const { findMostSimilarMemento } = mementoService;

export const handler = withEventContext(async (event, logger) => {
  const { userId, prompt, model, sessionId, questId } = LLMEvents.CompletionCompleted.schema.parse(event.properties);

  logger.updateMetadata({
    userId,
    prompt,
    model,
    sessionId,
    questId,
  });

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
    userId,
    {
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
      },
      getSettingsByNames,
    },
    { logger }
  );

  // STEP 1: Evaluate prompt first to understand the personal information
  const mementoEvaluator = new MementoEvaluationService(logger);
  const evaluations = await mementoEvaluator.evaluate({
    apiKeyTable,
    model: model as ChatModels,
    prompt,
    endUserId: userId,
  });

  if (!evaluations || evaluations.length === 0) {
    logger.info('Memento evaluation returned null or empty (not personally significant), skipping creation');
    return;
  }

  logger.updateMetadata({
    evaluationsCount: evaluations.length,
    evaluations,
  });

  console.debug('Evaluation results:', { count: evaluations.length, evaluations });

  // STEP 3: Get existing HOT mementos once (shared across all evaluations)
  const SIMILARITY_THRESHOLD = 0.88;
  const existingMementos = await Memento.find({ userId, tier: MementoTier.HOT }).select(
    'summary embedding weight lastAccessedAt fullContent tags'
  );

  logger.debug(`Retrieved ${existingMementos.length} existing HOT mementos for similarity checking`);

  // STEP 4: Process each evaluation
  let createdCount = 0;
  let updatedCount = 0;

  for (const evaluation of evaluations) {
    console.debug('Processing evaluation', { summary: evaluation.summary, importance: evaluation.importance });

    // Embed the summary, not the raw prompt - the summary is the actual personal info.
    // Shared helper (used by the manual create endpoint too); null degrades to an
    // un-embedded memento rather than failing when no embedding provider is available.
    const summaryEmbedding = await generateMementoSummaryEmbedding(evaluation.summary, {
      adminSettings: adminSettingsRepository,
      apiKeyTable,
      logger,
    });

    // Without an embedding we can't similarity-match against existing HOT mementos;
    // skip the dedup step and create a standalone memento below.
    if (summaryEmbedding) {
      const { memento: mostSimilarMemento, similarity: highestSimilarity } = findMostSimilarMemento(
        summaryEmbedding,
        existingMementos
      );

      // STEP 5: Handle similar personal information - update existing memento
      if (highestSimilarity >= SIMILARITY_THRESHOLD && mostSimilarMemento) {
        console.info('Similar personal information found, updating existing memento', {
          existingMementoId: mostSimilarMemento.id,
          similarity: highestSimilarity.toFixed(3),
          existingSummary: mostSimilarMemento.summary,
          newSummary: evaluation.summary,
        });

        const newWeight = Math.max(mostSimilarMemento.weight, evaluation.importance * 100);
        const updatedFullContent = `${mostSimilarMemento.fullContent}\n\n[Update]: ${prompt}`;

        const mergedTags = Array.from(new Set([...(mostSimilarMemento.tags || []), ...(evaluation.tags || [])]));

        await Memento.updateOne(
          { _id: mostSimilarMemento.id },
          {
            $set: {
              summary: evaluation.summary,
              fullContent: updatedFullContent, // append new prompt to history
              embedding: summaryEmbedding,
              weight: newWeight,
              lastAccessedAt: new Date(),
              tags: mergedTags,
            },
          }
        );

        console.info('Successfully updated existing memento with new information', {
          mementoId: mostSimilarMemento.id,
          newWeight,
          newSummary: evaluation.summary,
        });

        updatedCount++;
        continue;
      }

      console.debug(
        `No similar personal information found (highest similarity: ${highestSimilarity.toFixed(3)}), creating new memento`
      );
    }

    // STEP 6: No duplicate (or no embedding available) - create new memento
    const memento = await Memento.create({
      userId,
      sessionId,
      questId,
      type: MementoType.PROMPT,
      tier: MementoTier.HOT,
      weight: evaluation.importance * 100, // Scale 1-10 importance to 100-1000
      summary: evaluation.summary,
      fullContent: prompt,
      tags: evaluation.tags || [],
      ...(summaryEmbedding ? { embedding: summaryEmbedding } : {}),
      lastAccessedAt: new Date(),
    });

    logger.info('Successfully created memento', {
      mementoId: memento.id,
      importance: evaluation.importance,
      weight: memento.weight,
      embeddingLength: summaryEmbedding?.length ?? 0,
    });

    createdCount++;

    // Only embedded mementos participate in the in-batch similarity checks.
    if (summaryEmbedding) existingMementos.push(memento);
  }

  logger.info('Completed processing all memento evaluations', {
    total: evaluations.length,
    created: createdCount,
    updated: updatedCount,
  });
});
