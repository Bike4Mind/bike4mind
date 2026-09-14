import { memoryLedgerRepository, memoryPrincipalKeyRepository } from '@bike4mind/database';
import { embeddingScorer, recall } from '@bike4mind/memory';
import { MEMENTO_MIN_SIMILARITY } from '@bike4mind/common';
import { createKeyProvider } from './factCipher';
import { createLedgerMemoryStore } from './ledgerMemoryStore';
import { embedMementoQuery } from './mementoQueryEmbedding';

/**
 * How far heat (ACT-R activation) may move a belief relative to topicality, matching the user-memento
 * recall. A lake decays far slower (LAKE_ACTIVATION), so months-old reference facts stay warm; the
 * query is still the primary axis and heat the tiebreak.
 *
 * Stays a coded constant while the belief budget (`opts.k`) became an admin setting: #2496 was a
 * volume diagnosis - 8 beliefs is too little grounding for a document corpus - and this weight
 * changes the ORDER of what fits the budget, not how much fits. Worth exposing once something
 * measures the ranking as the limiter; nothing has.
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
  /**
   * `YYYY-MM-DD` of the source document, when it is known. Absent for a belief whose document has
   * since been deleted, and for a run with no dates resolver wired - both render as unknown rather
   * than as a guess.
   */
  sourceDate?: string;
}

export interface RecallLakeMemoryOptions {
  /** The chat user - embeds the query in the deployment-wide MEMENTO space (entitlement gated upstream). */
  userId: string;
  query: string;
  /** The user's accessible lakes, each paired with its DEK owner. Resolved by the caller. */
  lakes: AccessibleLake[];
  /**
   * Most beliefs to return, a SHARED budget across `lakes` (one merged card). The
   * `lakeMemoryRecallK` admin setting, resolved per turn in LakeMemoryFeature with a coded
   * fallback. Required rather than defaulted: a default here would be a second copy of
   * LAKE_RECALL_K_DEFAULT that could drift from the setting's own, which is the exact trap the
   * hardcoded 8 this replaced represented.
   *
   * `recall` applies it as a pure cap AFTER the cosine floor (recall.ts: filter, then sort, then
   * slice), so raising it admits more QUALIFYING beliefs and never a sub-floor one.
   */
  k: number;
  /**
   * Which of these source FabFile ids are currently retrievable for citation. A belief is surfaced
   * only if at least one of its source docs is reachable, so the card never leans on content the
   * knowledge tool would refuse (#1440 reachability - mirrors the corpus defer gate in
   * ChatCompletionProcess: fully vectorized, same embedding-model, not excluded/deleted/archived).
   * Injected because it needs the caller's retrieval filter, embedding-model and FabFile reads.
   */
  resolveReachableSources: (sourceIds: string[]) => Promise<Set<string>>;
  /**
   * When each source document was authored, for dating the recalled beliefs (#1501). Resolved AFTER
   * the budget cut, so it reads only the slice that will actually be rendered rather than every
   * source the reachability gate scans.
   *
   * Optional so a caller that has no FabFile access still recalls (undated) rather than failing; the
   * production wiring always supplies it.
   */
  resolveSourceDates?: (sourceIds: string[]) => Promise<Map<string, string>>;
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
  // reads run concurrently, and DEGRADE PER LAKE: a single lake's failure (decrypt error, missing DEK,
  // an archived lake) must not sink the others' memory, so a rejection drops that one lake and logs,
  // rather than rejecting the whole recall (which would lose ALL lake grounding for the turn).
  const settled = await Promise.allSettled(
    opts.lakes.map(({ datalakeTag, ownerUserId }) =>
      createLedgerMemoryStore({ ledger: memoryLedgerRepository, keys, ownerUserId }).readProfile({
        kind: 'lake',
        id: datalakeTag,
      })
    )
  );
  const profiles = settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn(
      `[lakeMemory] profile read failed for lake ${opts.lakes[i].datalakeTag}; skipping it this turn: ${
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      }`
    );
    return null;
  });

  // Beliefs from different lakes never collide: `belief.id` is an HMAC under each lake's own key, so a
  // cross-lake merge needs no dedup. `foldEvents` already deduped within each lake.
  const beliefs = profiles.flatMap(p => p?.beliefs ?? []).filter(b => !b.shredded);
  if (beliefs.length === 0) return [];

  // Reachability gate + query embed are independent of each other (both derive from the belief set),
  // so resolve them together.
  const allSourceIds = [...new Set(beliefs.flatMap(b => b.sources ?? []))];
  const [reachable, embedded] = await Promise.all([
    opts.resolveReachableSources(allSourceIds),
    embedMementoQuery(opts.userId, opts.query).catch(err => {
      // Degrade to the lexical scorer, but LOUDLY: a silent empty vector makes a failed embed look
      // identical to an empty profile, which is a painful misdiagnosis during the eval.
      console.warn(
        `[lakeMemory] query embedding failed; recall degraded to lexical this turn: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { vector: [] as number[], model: '' };
    }),
  ]);

  // Keep a belief only if at least one source doc is citable. A belief carrying no sources cannot be
  // verified against the corpus, so it is dropped rather than surfaced uncited.
  const citable = beliefs.filter(b => (b.sources ?? []).some(id => reachable.has(id)));
  if (citable.length === 0) return [];

  const recalled = recall(citable, opts.query, {
    k: opts.k,
    activationWeight: LAKE_ACTIVATION_WEIGHT,
    // The cosine floor is calibrated for the MEMENTO space, so it only applies when we actually scored
    // with an embedding; a lexical fallback uses an unrelated scale and no floor.
    ...(embedded.vector.length
      ? { scorer: embeddingScorer(embedded.vector), minRelevance: MEMENTO_MIN_SIMILARITY }
      : {}),
  }).map(r => ({ fact: r.belief.fact, relevance: r.relevance, sources: r.belief.sources ?? [] }));

  if (!opts.resolveSourceDates || recalled.length === 0) return recalled;

  // Dating is a nicety, not the grounding itself: a failed read costs the dates, never the facts.
  const dates = await opts.resolveSourceDates([...new Set(recalled.flatMap(r => r.sources))]).catch((err: unknown) => {
    console.warn(
      `[lakeMemory] source date read failed; beliefs render undated this turn: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return new Map<string, string>();
  });

  return recalled.map(r => {
    // A belief can cite more than one document; date it by the MOST RECENT, which is the claim's
    // latest restatement and the one a reader would weigh.
    const dated = r.sources.map(id => dates.get(id)).filter((d): d is string => Boolean(d));
    const sourceDate = dated.length ? dated.reduce((latest, d) => (d > latest ? d : latest)) : undefined;
    return sourceDate ? { ...r, sourceDate } : r;
  });
}
