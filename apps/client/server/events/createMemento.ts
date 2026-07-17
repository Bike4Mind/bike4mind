import { withEventContext } from '@server/events/utils';
import { LLMEvents } from '@server/utils/eventBus';
import { apiKeyRepository, adminSettingsRepository, Memento } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import {
  ChatModels,
  isSupportedEmbeddingModel,
  MEMENTO_EMBEDDING_MODEL,
  toMementoVector,
  MementoTier,
  MementoType,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { apiKeyService, MementoEvaluationService, mementoService } from '@bike4mind/services';
import { isMementosV2Enabled, writeFactToLedger } from '@server/memory/mementoLedgerMirror';

const { findMostSimilarMemento } = mementoService;

type EmbeddingService = ReturnType<EmbeddingFactory['createEmbeddingService']>;

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

  // STEP 1: Evaluate the prompt into distinct facts. The fact-style extraction prompt is a V2 change:
  // with V2 off the extraction is main's prompt, so a flag-off V1 user's mementos read exactly as before.
  const mementoEvaluator = new MementoEvaluationService(logger);
  const evaluations = await mementoEvaluator.evaluate({
    apiKeyTable,
    model: model as ChatModels,
    prompt,
    endUserId: userId,
    factStyle: writeV2,
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

  // STEP 2a: V2 embedding service. The ledger is its OWN corpus, pinned to MEMENTO_EMBEDDING_MODEL and
  // independent of the admin `defaultEmbeddingModel` that governs V1/FAB. A missing key degrades to a
  // vector-less ledger write (the fact stays lexically recallable and the re-embed backfill vectorizes
  // it later) rather than dropping the fact.
  let v2EmbeddingService: EmbeddingService | null = null;
  if (writeV2) {
    const v2Provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
    const v2Config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
    let v2KeyMissing = false;
    if (v2Provider === 'openai') {
      if (!apiKeyTable?.openai) v2KeyMissing = true;
      else v2Config.openaiApiKey = apiKeyTable.openai;
    } else if (v2Provider === 'voyageai') {
      if (!apiKeyTable?.voyageai) v2KeyMissing = true;
      else v2Config.voyageApiKey = apiKeyTable.voyageai;
    }
    if (v2KeyMissing) {
      logger.warn(
        `No ${v2Provider} API key for the V2 ledger embedding (${MEMENTO_EMBEDDING_MODEL}); writing facts WITHOUT a vector. They stay lexically recallable, and the re-embed backfill will vectorize them once a key is present.`
      );
    } else {
      v2EmbeddingService = new EmbeddingFactory(v2Config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
    }
  }

  // STEP 2b: V1 embedding service. Held to main's behavior exactly - the admin `defaultEmbeddingModel`,
  // so the V1 corpus and the V1 query (getRelevantMementos) share a vector space - and a hard failure on
  // a missing key or unconfigured model, because a V1 memento without a comparable vector is unrecallable.
  let v1EmbeddingService: EmbeddingService | null = null;
  if (writeV1) {
    const defaultEmbeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
    if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) {
      throw new Error('Default embedding model not configured. Please configure it in admin settings.');
    }
    const v1Provider = getProviderFromModel(defaultEmbeddingModel);
    const v1Config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
    if (v1Provider === 'openai') {
      if (!apiKeyTable?.openai) {
        throw new Error('OpenAI API key is required for embedding generation but not found. Please add your API key.');
      }
      v1Config.openaiApiKey = apiKeyTable.openai;
    } else if (v1Provider === 'voyageai') {
      if (!apiKeyTable?.voyageai) {
        throw new Error('VoyageAI API key is required for embedding generation but not found. Please add your API key.');
      }
      v1Config.voyageApiKey = apiKeyTable.voyageai;
    }
    // Bedrock uses AWS credentials, no API key needed
    v1EmbeddingService = new EmbeddingFactory(v1Config).createEmbeddingService(
      defaultEmbeddingModel as SupportedEmbeddingModel
    );
  }

  // STEP 3: Existing HOT mementos for V1 de-dup (V1 only - a V2-only user has none; V2 de-dups against
  // its own ledger inside writeFactToLedger).
  const SIMILARITY_THRESHOLD = 0.88;
  const existingMementos = writeV1
    ? await Memento.find({ userId, tier: MementoTier.HOT }).select(
        'summary embedding weight lastAccessedAt fullContent tags'
      )
    : [];

  logger.debug(`Retrieved ${existingMementos.length} existing HOT mementos for similarity checking`);

  // STEP 4: Process each evaluation
  let createdCount = 0;
  let updatedCount = 0;

  for (const evaluation of evaluations) {
    console.debug('Processing evaluation', { importance: evaluation.importance });

    // V2 persists the fact on its own terms - its own subject resolution and its own semantic de-dup
    // against its own ledger, in the 3-small space. It does not wait on, or read, anything V1 does below.
    if (writeV2) {
      const v2Embedding = v2EmbeddingService
        ? toMementoVector(await v2EmbeddingService.generateEmbedding(evaluation.summary))
        : undefined;
      await writeToLedger(evaluation.summary, v2Embedding);
    }

    if (!writeV1) {
      createdCount++;
      continue;
    }

    // V1 memento write - main's behavior: admin-default embedding, 0.88 cosine de-dup, no model stamp.
    const summaryEmbedding = await v1EmbeddingService!.generateEmbedding(evaluation.summary);
    logger.debug('Summary embedding generated', { embeddingLength: summaryEmbedding.length });

    const { memento: mostSimilarMemento, similarity: highestSimilarity } = findMostSimilarMemento(
      summaryEmbedding,
      existingMementos
    );

    // STEP 5: Handle similar personal information - update existing memento
    if (highestSimilarity >= SIMILARITY_THRESHOLD && mostSimilarMemento) {
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
      embedding: summaryEmbedding,
      lastAccessedAt: new Date(),
    });

    logger.info('Successfully created memento with embedding', {
      mementoId: memento.id,
      importance: evaluation.importance,
      weight: memento.weight,
      embeddingLength: summaryEmbedding.length,
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
