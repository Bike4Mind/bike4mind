import { withEventContext } from '@server/events/utils';
import { LLMEvents } from '@server/utils/eventBus';
import { apiKeyRepository, adminSettingsRepository, Memento } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import {
  ChatModels,
  MEMENTO_DEDUP_SIMILARITY,
  MEMENTO_EMBEDDING_ID,
  MEMENTO_EMBEDDING_MODEL,
  mementoEmbeddingIsCurrent,
  toMementoVector,
  MementoTier,
  MementoType,
} from '@bike4mind/common';
import { apiKeyService, MementoEvaluationService, mementoService } from '@bike4mind/services';
import { isMementosV2Enabled, writeFactToLedger } from '@server/memory/mementoLedgerMirror';

const { findMostSimilarMemento } = mementoService;

export const handler = withEventContext(async (event, logger) => {
  const { userId, prompt, model, sessionId, questId, ...flags } = LLMEvents.CompletionCompleted.schema.parse(
    event.properties
  );

  // WHICH pipelines capture this turn. The publisher resolves both (it is the only place that sees the
  // user's opt-ins AND the admin override) - but an event in flight from before those fields existed
  // has neither, and could only have come from the V1-gated publisher, so a missing `enableMementos`
  // reads as true.
  const writeV1 = flags.enableMementos ?? true;
  const writeV2 = flags.enableMementosV2 ?? (await isMementosV2Enabled(userId).catch(() => false));

  if (!writeV1 && !writeV2) {
    logger.info('Neither memento pipeline is enabled for this user, skipping');
    return;
  }

  // Deliberately NOT logging `prompt` or the extracted summaries: they are the exact plaintext V2
  // encrypts, and logs have their own retention outside the crypto-shred boundary - a shred that
  // destroys the DEK would leave the fact readable in log storage. Counts and ids only.
  logger.updateMetadata({
    userId,
    model,
    sessionId,
    questId,
    writeV1,
    writeV2,
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

  logger.updateMetadata({ evaluationsCount: evaluations.length });

  // The V2 write. When V1 is also on the two run side by side (a flip back to V1 loses nothing); when
  // V1 is OFF this is the only thing that persists the fact, which is what makes V2 standalone.
  //
  // Best-effort ONLY while V1 is also writing - if V2 is the sole pipeline, a swallowed failure would
  // mean the user told us something and we quietly dropped it, so it must surface.
  const sources = [sessionId, questId].filter((x): x is string => Boolean(x));
  const writeToLedger = async (summary: string, embedding?: number[]) => {
    if (!writeV2) return;
    try {
      await writeFactToLedger({ userId, summary, sources, embedding });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!writeV1) throw new Error(`Mementos V2 is the only enabled pipeline and its write failed: ${message}`);
      logger.warn('Mementos V2: ledger write failed (V1 memento unaffected)', { error: message });
    }
  };

  // STEP 2: Set up the embedding service. Mementos pin their OWN model rather than following the
  // `defaultEmbeddingModel` admin setting (which governs the FAB file corpus) - the two corpora
  // migrate on their own schedules. See MEMENTO_EMBEDDING_MODEL.
  const requiredProvider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);

  // Only include the API key the chosen provider actually needs
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};

  // A MISSING embedding key is a config gap, not a reason to lose the fact. Recall has a lexical
  // (Jaccard) fallback for vector-less beliefs, and the re-embed backfill fills the vector in later, so
  // we degrade to a no-vector write (loud warning) rather than abort - which would drop BOTH the V1 and
  // V2 write for every evaluation in this turn. A runtime embedding ERROR still throws below (transient,
  // should surface and retry). `embeddingService === null` means "write facts without a vector".
  let embeddingKeyMissing = false;
  if (requiredProvider === 'openai') {
    if (!apiKeyTable?.openai) embeddingKeyMissing = true;
    else embeddingConfig.openaiApiKey = apiKeyTable.openai;
  } else if (requiredProvider === 'voyageai') {
    if (!apiKeyTable?.voyageai) embeddingKeyMissing = true;
    else embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
  }
  // Bedrock uses AWS credentials, no API key needed

  if (embeddingKeyMissing) {
    logger.warn(
      `No ${requiredProvider} API key for memento embedding (${MEMENTO_EMBEDDING_MODEL}); writing facts WITHOUT a vector. They stay lexically recallable, and the re-embed backfill will vectorize them once a key is present.`
    );
  }

  const embeddingService = embeddingKeyMissing
    ? null
    : new EmbeddingFactory(embeddingConfig).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);

  // STEP 3: Get existing HOT mementos once (shared across all evaluations). V1 ONLY - these exist to
  // de-dup against the V1 collection, and a V2-only user does not have one. V2 de-dups against its own
  // ledger inside writeFactToLedger.
  const hotMementos = writeV1
    ? await Memento.find({ userId, tier: MementoTier.HOT }).select(
        'summary embedding embeddingModel weight lastAccessedAt fullContent tags'
      )
    : [];

  // De-dup compares the new summary's vector against these by cosine, so a memento embedded in a
  // DIFFERENT model's space cannot take part: the similarity would be noise, and noise below the
  // threshold reads exactly like "not a duplicate" - so the same fact gets stored twice, forever.
  // Excluding them means a stale memento may be duplicated once; including them would corrupt the
  // decision silently. The backfill re-embeds them and the exclusion empties out.
  const existingMementos = hotMementos.filter(mementoEmbeddingIsCurrent);
  const staleCount = hotMementos.length - existingMementos.length;
  if (staleCount > 0) {
    logger.warn(
      `${staleCount} of ${hotMementos.length} HOT mementos carry a vector from another embedding model and are excluded from de-dup; run the memento re-embed backfill`
    );
  }

  logger.debug(`Retrieved ${existingMementos.length} existing HOT mementos for similarity checking`);

  // STEP 4: Process each evaluation
  let createdCount = 0;
  let updatedCount = 0;

  for (const evaluation of evaluations) {
    console.debug('Processing evaluation', { importance: evaluation.importance });

    // Embed the summary, not the raw prompt - the summary is the actual personal info
    // Truncate into the memento vector space. Every memento path must do this to the SAME width, or
    // the stored fact and the query scoring it land in different spaces and cosine returns noise.
    // `undefined` when no embedding key is configured (see the degrade note above).
    const summaryEmbedding = embeddingService
      ? toMementoVector(await embeddingService.generateEmbedding(evaluation.summary))
      : undefined;
    if (summaryEmbedding) logger.debug('Summary embedding generated', { embeddingLength: summaryEmbedding.length });

    // V2 persists the fact on its own terms - its own subject resolution and its own semantic de-dup
    // against its own ledger. It does not wait on, or read, anything V1 does below.
    await writeToLedger(evaluation.summary, summaryEmbedding);

    if (!writeV1) {
      createdCount++;
      continue;
    }

    // Cosine de-dup needs a vector on BOTH sides. With no embedding this turn, skip straight to a
    // fresh (vector-less) write - a possible duplicate is the accepted cost of not losing the fact.
    const { memento: mostSimilarMemento, similarity: highestSimilarity } = summaryEmbedding
      ? findMostSimilarMemento(summaryEmbedding, existingMementos)
      : { memento: undefined, similarity: 0 };

    // STEP 5: Handle similar personal information - update existing memento
    if (highestSimilarity >= MEMENTO_DEDUP_SIMILARITY && mostSimilarMemento) {
      console.info('Similar personal information found, updating existing memento', {
        existingMementoId: mostSimilarMemento.id,
        similarity: highestSimilarity.toFixed(3),
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
            embeddingModel: MEMENTO_EMBEDDING_ID,
            weight: newWeight,
            lastAccessedAt: new Date(),
            tags: mergedTags,
          },
        }
      );

      console.info('Successfully updated existing memento with new information', {
        mementoId: mostSimilarMemento.id,
        newWeight,
      });

      updatedCount++;
      continue;
    }

    console.debug(
      `No similar personal information found (highest similarity: ${highestSimilarity.toFixed(3)}), creating new memento`
    );

    // STEP 6: No duplicate - create new memento
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
      // Stamp the model ONLY alongside a real vector - an un-stamped memento is treated as untrusted
      // and gets picked up by the re-embed backfill, which is exactly what a vector-less write wants.
      ...(summaryEmbedding ? { embedding: summaryEmbedding, embeddingModel: MEMENTO_EMBEDDING_ID } : {}),
      lastAccessedAt: new Date(),
    });

    logger.info('Successfully created memento', {
      mementoId: memento.id,
      importance: evaluation.importance,
      weight: memento.weight,
      embeddingLength: summaryEmbedding?.length ?? 0,
    });

    createdCount++;

    // Add to existingMementos for subsequent similarity checks in this batch
    existingMementos.push(memento);
  }

  logger.info('Completed processing all memento evaluations', {
    total: evaluations.length,
    created: createdCount,
    updated: updatedCount,
  });
});
