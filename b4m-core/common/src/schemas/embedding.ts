import { z } from 'zod';

export enum OpenAIEmbeddingModel {
  TEXT_EMBEDDING_3_SMALL = 'text-embedding-3-small',
  TEXT_EMBEDDING_3_LARGE = 'text-embedding-3-large',
  TEXT_EMBEDDING_ADA_002 = 'text-embedding-ada-002',
}

export enum VoyageAIEmbeddingModel {
  VOYAGE_3_LARGE = 'voyage-3-large',
  VOYAGE_3 = 'voyage-3',
  VOYAGE_3_LITE = 'voyage-3-lite',
  VOYAGE_CODE_3 = 'voyage-code-3',
  VOYAGE_FINANCE_3 = 'voyage-finance-3',
  VOYAGE_LAW_3 = 'voyage-law-3',
}

export enum BedrockEmbeddingModel {
  TITAN_TEXT_EMBEDDINGS_V2 = 'amazon.titan-embed-text-v2:0',
  // As of 2025-03-27, titan-embed-text-v2:0 is the only supported model for us-east-2 region.
}

export const SupportedEmbeddingModelSchema = z.union([
  z.enum(OpenAIEmbeddingModel),
  z.enum(VoyageAIEmbeddingModel),
  z.enum(BedrockEmbeddingModel),
]);

export type SupportedEmbeddingModel = z.infer<typeof SupportedEmbeddingModelSchema>;

export function isSupportedEmbeddingModel(model: string): model is SupportedEmbeddingModel {
  return SupportedEmbeddingModelSchema.safeParse(model).success;
}

/**
 * The model mementos embed with - PINNED here rather than read from the `defaultEmbeddingModel` admin
 * setting, which governs the FAB file/RAG corpus.
 *
 * The two corpora are deliberately decoupled because they migrate independently: a memento is one
 * short sentence and re-embedding all of them is minutes of work, while the file corpus is large and
 * grows. Tying them together would mean neither could move until both could. (Reuniting them is the
 * whole point of the FAB-corpus migration issue; this pin is what lets memory go first.)
 *
 * Chosen by measurement, not taste - see b4m-core/memory/src/eval. Against ada-002 on the same corpus:
 * MRR 1.000 vs 0.953 (the right belief ranked FIRST for every query), precision 94% vs 48%, and a
 * fifth the cost per token. It is also 1536-dim, same as ada-002, so nothing about the vector storage
 * changes.
 */
export const MEMENTO_EMBEDDING_MODEL: SupportedEmbeddingModel = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;

/**
 * Topicality floor for memento retrieval: below this cosine to the query, a memento is not surfaced.
 *
 * THIS NUMBER IS A PROPERTY OF MEMENTO_EMBEDDING_MODEL, NOT OF THE MEMORY SYSTEM. It lives here, glued
 * to the model it was measured against, because the two are one decision and changing either alone is
 * a silent outage. That is not hypothetical: mementos previously ran on ada-002, whose cosines are
 * crushed into a ~0.72-0.81 band, and the read paths floored at 0.75. The same corpus under 3-small
 * scores 0.28-0.38 - a BETTER separation, spread across a wider band - so the old 0.75 floor rejects
 * literally every memento. The eval caught exactly that: V1 scored hit@10 of 0.0%, memory silently
 * dark, no error anywhere.
 *
 * The rule: the strictest floor that still forgets NOTHING. A higher floor buys precision by dropping
 * something the user actually told us, and that trade is not ours to make silently.
 *
 * 0.25, not the 0.313 the eval corpus alone would pick - and the gap is the interesting part. The
 * corpus states facts crisply ("Dana is severely allergic to shellfish"), but mementos are written by
 * an LLM summarising a conversation, and it HEDGES: "User conducts discovery calls, suggesting a role
 * in sales". Hedged, abstract phrasing sits measurably further from a plain question than a crisp fact
 * does. Measured against a real user's mementos: the best match for "what do I do for work" scores
 * 0.2991 - a genuine, useful memory that the corpus-optimal 0.313 would silently discard, while true
 * noise ("what is the capital of Peru") tops out around 0.14. The synthetic corpus is a proxy and it
 * FLATTERS us on this axis; the margin is what pays for that.
 *
 * Re-derive with b4m-core/memory/src/eval/tuning.test.ts if the model moves - and sanity-check the
 * result against real mementos, because the corpus will keep telling you a higher floor is safe.
 */
export const MEMENTO_MIN_SIMILARITY = 0.25;

/**
 * De-dup threshold: at or above this cosine, a newly extracted fact is treated as a RESTATEMENT of a
 * belief the user already has - it updates that belief in place and counts as another presentation of
 * it (raising its ACT-R activation) rather than becoming a second belief.
 *
 * Like MEMENTO_MIN_SIMILARITY this is a raw cosine and therefore a property of MEMENTO_EMBEDDING_MODEL,
 * so it lives next to it. The two failure modes are asymmetric and both bad:
 *   - too LOW: a genuinely new fact silently OVERWRITES a different one. "Allergic to shellfish" and
 *     "allergic to peanuts" are one word apart; merging them is a medical error we would never see.
 *   - too HIGH: memory fills with restatements of the same fact, each diluting the others' activation
 *     and spending prompt budget several times over on one thing.
 *
 * Measured (b4m-core/memory/src/eval/dedup.test.ts): restatements score 0.928-0.957, while DISTINCT
 * facts about the same subject in the same words top out at 0.854 ("same role, different research").
 * The band is cleanly separable and 0.89 is its midpoint, so this sits as far from both walls as the
 * evidence allows.
 *
 * Note the old threshold was 0.88, chosen against ada-002. It happens to land inside 3-small's band
 * too - but by luck, not design, and nothing would have told us if it had not. That is the entire
 * reason it is now a measured constant here instead of a literal in the write path.
 */
export const MEMENTO_DEDUP_SIMILARITY = 0.89;

/**
 * Is this memento's stored vector in the CURRENT space, i.e. can it legally be compared against a
 * query embedded with MEMENTO_EMBEDDING_MODEL?
 *
 * Cosine between two different models' spaces is not "a bit worse", it is MEANINGLESS - unrelated
 * noise that a similarity floor will either reject wholesale (memory silently goes dark) or admit at
 * random. So every read path must gate on this, and an un-stamped memento (written before the model
 * was recorded) is treated as untrusted rather than assumed: what produced it is genuinely unknown,
 * and guessing is how you get silent garbage. Such mementos are repaired by the re-embed backfill.
 */
export const mementoEmbeddingIsCurrent = (memento: { embeddingModel?: string | null }): boolean =>
  memento.embeddingModel === MEMENTO_EMBEDDING_MODEL;

/**
 * Public list price in USD per input token, by embedding model. Embeddings bill on
 * input tokens only (no output). These are list prices for COGS estimation, not a
 * contract; update alongside provider price changes. Models absent here settle at
 * $0 with an alarm (see getEmbeddingModelCost) so a missing rate never blocks the
 * usage-event write nor silently over-bills.
 */
const EMBEDDING_MODEL_PRICE_PER_TOKEN: Partial<Record<SupportedEmbeddingModel, number>> = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: 0.02 / 1_000_000,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE]: 0.13 / 1_000_000,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 0.1 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3_LARGE]: 0.18 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3]: 0.06 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3_LITE]: 0.02 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_CODE_3]: 0.18 / 1_000_000,
  [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2]: 0.02 / 1_000_000,
};

/** Compute USD cost for an embedding call. Unpriced models settle $0 with an alarm. */
export const getEmbeddingModelCost = (model: string, inputTokens: number): number => {
  const rate = EMBEDDING_MODEL_PRICE_PER_TOKEN[model as SupportedEmbeddingModel];
  if (rate === undefined) {
    if (inputTokens > 0) {
      console.error(`[UNPRICED_EMBEDDING_MODEL] ${model} computed $0 for ${inputTokens} tokens; add its rate`);
    }
    return 0;
  }
  return rate * inputTokens;
};
