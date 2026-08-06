import { memoryLedgerRepository, memoryPrincipalKeyRepository } from '@bike4mind/database';
import { embeddingScorer, recall } from '@bike4mind/memory';
import { MEMENTO_MIN_SIMILARITY } from '@bike4mind/common';
import { createKeyProvider } from './factCipher';
import { createLedgerMemoryStore } from './ledgerMemoryStore';
import { embedMementoQuery } from './mementoQueryEmbedding';

/**
 * How many lake beliefs to inject at most - the same k the user-memento recall settled on
 * (recallMementosV2). One merged card across the user's accessible lakes, so this is a shared budget.
 */
const LAKE_RECALL_K = 8;

/**
 * How far heat (ACT-R activation) may move a belief relative to topicality, matching the user-memento
 * recall. A lake decays far slower (LAKE_ACTIVATION), so months-old reference facts stay warm; the
 * query is still the primary axis and heat the tiebreak.
 */
const LAKE_ACTIVATION_WEIGHT = 0.025;

/** An entitled lake to read: its `datalake:` tag and the DEK owner (the lake's `createdByUserId`). */
export interface AccessibleLake {
  datalakeTag: string;
  ownerUserId: string;
}

export interface LakeBeliefRecall {
  fact: string;
  relevance: number;
  /** Source FabFile ids the fact was extracted from, for citation. Always at least one (reachable). */
  sources: string[];
}

export interface RecallLakeMemoryOptions {
  /** The chat user - embeds the query in the deployment-wide MEMENTO space (entitlement gated upstream). */
  userId: string;
  query: string;
  /** The user's accessible lakes, each paired with its DEK owner. Resolved by the caller. */
  lakes: AccessibleLake[];
  /**
   * Which of these source FabFile ids are currently retrievable for citation. A belief is surfaced
   * only if at least one of its source docs is reachable, so the card never leans on content the
   * knowledge tool would refuse (#1440 reachability - mirrors the corpus defer gate in
   * ChatCompletionProcess: fully vectorized, same embedding-model, not excluded/deleted/archived).
   * Injected because it needs the caller's retrieval filter, embedding-model and FabFile reads.
   */
  resolveReachableSources: (sourceIds: string[]) => Promise<Set<string>>;
}

/**
 * Read the lake memory hot-card for a Data-Lake-mode turn: fold each accessible lake's ledger into its
 * belief set, keep only beliefs whose source doc is still citable, and recall the top beliefs for the
 * query. Returns [] (not null) when nothing qualifies - there is no user opt-in to defer to here, the
 * Data-Lake toggle IS the trigger, resolved by the caller.
 *
 * Distinct from `recallMementosV2` (the USER's own memory, gated on their opt-in): this reads a
 * different principal (`{ kind: 'lake', id: datalakeTag }`, owned by the lake creator) and is gated on
 * `session.forceKnowledgeRetrieval`. The substrate is the same principal-agnostic ledger store, so no
 * new adapter is needed - each lake is read under its own owner's key.
 *
 * Retrieval is SEMANTIC (cosine against the query embedded in the MEMENTO space); a belief without an
 * embedding falls back to the lexical scorer, and if the query cannot be embedded at all the whole
 * recall degrades to lexical rather than failing the turn.
 */
export async function recallLakeMemory(opts: RecallLakeMemoryOptions): Promise<LakeBeliefRecall[]> {
  if (opts.lakes.length === 0 || !opts.query.trim()) return [];

  const keys = createKeyProvider(memoryPrincipalKeyRepository);

  // Read each lake's profile under ITS OWN DEK owner - lakes can have different creators. Independent
  // reads run concurrently; a lake whose ledger is empty (nothing extracted yet) folds to null.
  const profiles = await Promise.all(
    opts.lakes.map(({ datalakeTag, ownerUserId }) =>
      createLedgerMemoryStore({ ledger: memoryLedgerRepository, keys, ownerUserId }).readProfile({
        kind: 'lake',
        id: datalakeTag,
      })
    )
  );

  // Beliefs from different lakes never collide: `belief.id` is an HMAC under each lake's own key, so a
  // cross-lake merge needs no dedup. `foldEvents` already deduped within each lake.
  const beliefs = profiles.flatMap(p => p?.beliefs ?? []).filter(b => !b.shredded);
  if (beliefs.length === 0) return [];

  // Reachability gate + query embed are independent of each other (both derive from the belief set),
  // so resolve them together.
  const allSourceIds = [...new Set(beliefs.flatMap(b => b.sources ?? []))];
  const [reachable, embedded] = await Promise.all([
    opts.resolveReachableSources(allSourceIds),
    embedMementoQuery(opts.userId, opts.query).catch(() => ({ vector: [] as number[], model: '' })),
  ]);

  // Keep a belief only if at least one source doc is citable. A belief carrying no sources cannot be
  // verified against the corpus, so it is dropped rather than surfaced uncited.
  const citable = beliefs.filter(b => (b.sources ?? []).some(id => reachable.has(id)));
  if (citable.length === 0) return [];

  return recall(citable, opts.query, {
    k: LAKE_RECALL_K,
    activationWeight: LAKE_ACTIVATION_WEIGHT,
    // The cosine floor is calibrated for the MEMENTO space, so it only applies when we actually scored
    // with an embedding; a lexical fallback uses an unrelated scale and no floor.
    ...(embedded.vector.length
      ? { scorer: embeddingScorer(embedded.vector), minRelevance: MEMENTO_MIN_SIMILARITY }
      : {}),
  }).map(r => ({ fact: r.belief.fact, relevance: r.relevance, sources: r.belief.sources ?? [] }));
}
