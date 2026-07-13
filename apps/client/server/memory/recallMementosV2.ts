import {
  adminSettingsRepository,
  apiKeyRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
  mementoRepository,
} from '@bike4mind/database';
import { embeddingScorer, mergeStores, recall } from '@bike4mind/memory';
import { isSupportedEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { createKeyProvider } from './factCipher';
import { createLedgerMemoryStore } from './ledgerMemoryStore';
import { createUserMementoMemoryStore } from './userMementoMemoryStore';
import { isMementosV2Enabled } from './mementoLedgerMirror';

/** How many beliefs V2 injects into the prompt at most. */
const V2_RECALL_K = 10;

/**
 * How far heat (ACT-R activation) may move a belief relative to topicality. The chat prompt is a
 * QUERY, so what the user just asked about is the primary axis and recency/frequency the tiebreaker.
 * `recall` normalizes both axes before blending, so this is a ratio, not a raw scale factor. Swept on
 * the eval corpus (b4m-core/memory/src/eval): 0.1 is the largest weight at which heat only reorders
 * genuine near-ties - ranking quality holds at parity with plain vector search up to 0.10 and
 * degrades beyond it.
 */
const V2_ACTIVATION_WEIGHT = 0.1;

/**
 * Topicality floor: a belief below this cosine to the query is not injected at all.
 *
 * THIS IS CALIBRATED PER EMBEDDING MODEL and cannot be a single constant, because the cosine scale is
 * a property of the model. `text-embedding-ada-002` is notoriously compressed - even unrelated text
 * scores ~0.72 - so the entire signal lives in a narrow band and 0.76 is the highest floor that loses
 * no relevant belief on the eval corpus while cutting the memory injected into an OFF-topic question
 * from 10 beliefs to 1.7.
 *
 * An UNKNOWN model deliberately falls back to NO floor. That degrades to the previous behaviour -
 * inject the top k, noisy but complete - rather than silently dropping a user's entire memory because
 * someone changed the embedding model and its cosine scale moved out from under a hardcoded number.
 * If you change the model: re-run the eval sweep and add the model here.
 */
const MIN_RELEVANCE_BY_MODEL: Record<string, number> = {
  'text-embedding-ada-002': 0.76,
};

/**
 * Embed the query in the SAME vector space as the stored memento embeddings - i.e. with the
 * admin-configured default embedding model and the user's effective API keys, exactly as V1's
 * `getRelevantMementos` and `createMemento` do. Cosine between vectors from different models is
 * meaningless, so this must stay in lockstep with them.
 *
 * Returns [] on any failure (no key, no model configured, provider error): recall then falls back to
 * the lexical scorer rather than breaking the chat.
 */
async function embedQuery(userId: string, query: string): Promise<{ vector: number[]; model: string }> {
  const none = { vector: [] as number[], model: '' };
  if (!query.trim()) return none;

  // Independent lookups - the configured model and the user's keys - so fetch them together rather
  // than paying two serial round trips to a remote Mongo.
  const [defaultEmbeddingModel, apiKeyTable] = await Promise.all([
    adminSettingsRepository.getSettingsValue('defaultEmbeddingModel'),
    apiKeyService.getEffectiveLLMApiKeys(userId, {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    }),
  ]);

  if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) return none;

  const provider = getProviderFromModel(defaultEmbeddingModel);
  const config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) return none;
    config.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) return none;
    config.voyageApiKey = apiKeyTable.voyageai;
  }

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(
    defaultEmbeddingModel as SupportedEmbeddingModel
  );
  return { vector: await embeddingService.generateEmbedding(query), model: defaultEmbeddingModel };
}

/**
 * Mementos V2 read seam for the chat/agent prompt. Injected into the chat completion service as
 * `recallMementosV2`. Returns null for a user on V1 (caller keeps the classic memento path); for a
 * V2 user it reads their unified memory (the ledger UNIONed with their legacy V1 mementos, so V2
 * surfaces existing data without a backfill), drops shredded beliefs, and recalls the top beliefs
 * for the query.
 *
 * Retrieval is SEMANTIC (cosine against the query's embedding), which is the parity gate against V1's
 * vector search: lexical overlap cannot match "what hue do I like?" to "favorite color is green".
 * Beliefs carry the embedding their V1 memento already stored (the merge hands it to the ledger twin
 * that lacks one), and any belief without an embedding falls back to the lexical scorer, so a mixed
 * set still ranks sensibly. If the query cannot be embedded at all, the whole recall degrades to
 * lexical rather than failing the chat.
 */
export async function recallMementosV2(
  userId: string,
  query: string,
  opts: { enabled?: boolean } = {}
): Promise<{ fact: string; relevance: number }[] | null> {
  // The chat resolves the opt-in from the user document it already holds and hands it over, so the
  // common path costs no round trip. Only a caller that does not know looks it up.
  const enabled = opts.enabled ?? (await isMementosV2Enabled(userId));
  if (!enabled) return null;

  const store = mergeStores([
    createLedgerMemoryStore({
      ledger: memoryLedgerRepository,
      keys: createKeyProvider(memoryPrincipalKeyRepository),
      ownerUserId: userId,
    }),
    createUserMementoMemoryStore({ mementos: mementoRepository, ownerUserId: userId }),
  ]);

  // The profile read and the query embedding are INDEPENDENT - one hits Mongo, the other an
  // embedding provider - so they run concurrently. Serially they cost their sum (~330ms + ~370ms);
  // together they cost the slower one. This is the single biggest win on the recall path.
  const [profile, embedded] = await Promise.all([
    store.readProfile({ kind: 'user', id: userId }),
    embedQuery(userId, query).catch(err => {
      // Falling back to lexical is the right call - never fail a chat turn over recall - but do it
      // LOUDLY. Silently, an embedding-provider outage just makes memory quietly worse: the model
      // still answers, so nothing looks broken while retrieval quality has collapsed to token overlap.
      console.warn(
        `[Mementos V2] query embedding failed; recall degraded to lexical for this turn: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { vector: [] as number[], model: '' };
    }),
  ]);
  const { vector: queryEmbedding, model: embeddingModel } = embedded;

  if (!profile) return [];

  const live = profile.beliefs.filter(b => !b.shredded); // never inject shredded content

  return recall(live, query, {
    k: V2_RECALL_K,
    activationWeight: V2_ACTIVATION_WEIGHT,
    // The floor only means anything in the vector space it was calibrated for; with no embedding the
    // scorer is lexical and its scale is different again, so no floor applies.
    ...(queryEmbedding.length
      ? {
          scorer: embeddingScorer(queryEmbedding),
          minRelevance: MIN_RELEVANCE_BY_MODEL[embeddingModel] ?? 0,
        }
      : {}),
  }).map(r => ({ fact: r.belief.fact, relevance: r.relevance }));
}
