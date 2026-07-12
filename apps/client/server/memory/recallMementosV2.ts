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
 * How hard topicality outweighs heat when ranking. The chat prompt is a QUERY, so what the user just
 * asked about should be the primary axis and ACT-R activation the tiebreaker - not the other way
 * round. Measured on real data: activation spans ~0..0.25 while cosine relevance spans ~0.3..0.9, so
 * an unweighted sum let a merely-hot, off-topic belief outrank a cold but perfectly on-topic one.
 * Weighting relevance makes the semantic signal dominant while heat still breaks ties between
 * equally-relevant beliefs. A generic query ("what do you know about me?") scores everything
 * similarly, so ranking degrades to activation order - the profile fallback - which is what we want.
 */
const V2_RELEVANCE_WEIGHT = 3;

/**
 * Embed the query in the SAME vector space as the stored memento embeddings - i.e. with the
 * admin-configured default embedding model and the user's effective API keys, exactly as V1's
 * `getRelevantMementos` and `createMemento` do. Cosine between vectors from different models is
 * meaningless, so this must stay in lockstep with them.
 *
 * Returns [] on any failure (no key, no model configured, provider error): recall then falls back to
 * the lexical scorer rather than breaking the chat.
 */
async function embedQuery(userId: string, query: string): Promise<number[]> {
  if (!query.trim()) return [];

  // Independent lookups - the configured model and the user's keys - so fetch them together rather
  // than paying two serial round trips to a remote Mongo.
  const [defaultEmbeddingModel, apiKeyTable] = await Promise.all([
    adminSettingsRepository.getSettingsValue('defaultEmbeddingModel'),
    apiKeyService.getEffectiveLLMApiKeys(userId, {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    }),
  ]);

  if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) return [];

  const provider = getProviderFromModel(defaultEmbeddingModel);
  const config: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) return [];
    config.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) return [];
    config.voyageApiKey = apiKeyTable.voyageai;
  }

  const embeddingService = new EmbeddingFactory(config).createEmbeddingService(
    defaultEmbeddingModel as SupportedEmbeddingModel
  );
  return embeddingService.generateEmbedding(query);
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
  const [profile, queryEmbedding] = await Promise.all([
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
      return [] as number[];
    }),
  ]);

  if (!profile) return [];

  const live = profile.beliefs.filter(b => !b.shredded); // never inject shredded content

  return recall(live, query, {
    k: V2_RECALL_K,
    relevanceWeight: V2_RELEVANCE_WEIGHT,
    ...(queryEmbedding.length ? { scorer: embeddingScorer(queryEmbedding) } : {}),
  }).map(r => ({ fact: r.belief.fact, relevance: r.relevance }));
}
