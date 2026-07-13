import {
  adminSettingsRepository,
  apiKeyRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
  mementoRepository,
} from '@bike4mind/database';
import { embeddingScorer, mergeStores, recall } from '@bike4mind/memory';
import { MEMENTO_EMBEDDING_MODEL, MEMENTO_MIN_SIMILARITY } from '@bike4mind/common';
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
 * Embed the query in the SAME vector space the mementos were written in - MEMENTO_EMBEDDING_MODEL,
 * which the memento write path pins and stamps. Cosine between vectors from different models is
 * meaningless, so this must stay in lockstep with `createMemento` and `getRelevantMementos`.
 *
 * Returns an empty vector on any failure (no key, provider error): recall then falls back to the
 * lexical scorer rather than breaking the chat.
 */
async function embedQuery(userId: string, query: string): Promise<{ vector: number[]; model: string }> {
  const none = { vector: [] as number[], model: '' };
  if (!query.trim()) return none;

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const provider = getProviderFromModel(MEMENTO_EMBEDDING_MODEL);
  const config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) return none;
    config.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) return none;
    config.voyageApiKey = apiKeyTable.voyageai;
  }

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(MEMENTO_EMBEDDING_MODEL);
  return { vector: await embeddingService.generateEmbedding(query), model: MEMENTO_EMBEDDING_MODEL };
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
  const { vector: queryEmbedding } = embedded;

  if (!profile) return [];

  const live = profile.beliefs.filter(b => !b.shredded); // never inject shredded content

  return recall(live, query, {
    k: V2_RECALL_K,
    activationWeight: V2_ACTIVATION_WEIGHT,
    // The floor is a cosine calibrated for MEMENTO_EMBEDDING_MODEL, so it only means anything when we
    // actually scored with that model. With no embedding the scorer is lexical, whose scale is
    // unrelated, and applying a cosine floor to a Jaccard score would reject everything.
    ...(queryEmbedding.length
      ? { scorer: embeddingScorer(queryEmbedding), minRelevance: MEMENTO_MIN_SIMILARITY }
      : {}),
  }).map(r => ({ fact: r.belief.fact, relevance: r.relevance }));
}
