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

// Local embedders served by Ollama for fully-offline self-host RAG. Values are the
// Ollama model tags (must match what OLLAMA_PULL_MODELS pulls). Dimensions and
// context windows live in OLLAMA_EMBEDDING_MODEL_MAP (fab-pipeline) and must stay in sync.
export enum OllamaEmbeddingModel {
  // Qwen3-Embedding: the recommended self-host default. 0.6b fits any GPU or CPU; 4b/8b need a
  // bigger card. Hardware table in .env.selfhost.example.
  QWEN3_EMBEDDING_0_6B = 'qwen3-embedding:0.6b',
  QWEN3_EMBEDDING_4B = 'qwen3-embedding:4b',
  QWEN3_EMBEDDING_8B = 'qwen3-embedding:8b',
  // nomic-embed-text: the cheap, tiny option (~0.3 GB) when you want the smallest footprint.
  NOMIC_EMBED_TEXT = 'nomic-embed-text',
  MXBAI_EMBED_LARGE = 'mxbai-embed-large',
  BGE_M3 = 'bge-m3',
  SNOWFLAKE_ARCTIC_EMBED = 'snowflake-arctic-embed',
}

/**
 * The default embedding model for the current deployment. On self-host with a local Ollama
 * server and no cloud embedding key, this is a local embedder, so RAG / knowledge search work
 * out of the box with no AWS/OpenAI/Voyage credential; otherwise it is the cloud default. Read
 * by the `defaultEmbeddingModel` admin-setting default and by the query-embedding fallback, so
 * an operator who never opens admin settings still gets a working, keyless embedder instead of
 * an unconfigured cloud model that fails with an opaque "security token" error.
 */
export function defaultEmbeddingModelForEnv(): SupportedEmbeddingModel {
  const selfHost = process.env.B4M_SELF_HOST === 'true';
  const hasOllama = !!process.env.OLLAMA_BASE_URL?.trim();
  // "Has a cloud embedding key" must match serverConfig.ts hasEmbeddingKey (OpenAI OR VoyageAI):
  // a self-host that configured a cloud embedder should keep the cloud default, not be silently
  // switched to the local embedder.
  const hasCloudEmbeddingKey = !!process.env.OPENAI_API_KEY?.trim() || !!process.env.VOYAGE_API_KEY?.trim();
  if (selfHost && hasOllama && !hasCloudEmbeddingKey) {
    return OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B;
  }
  return OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
}

export const SupportedEmbeddingModelSchema = z.union([
  z.enum(OpenAIEmbeddingModel),
  z.enum(VoyageAIEmbeddingModel),
  z.enum(BedrockEmbeddingModel),
  z.enum(OllamaEmbeddingModel),
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
 * fifth the cost per token. The model returns 1536 dims; mementos truncate that to 512 (Matryoshka,
 * see MEMENTO_EMBEDDING_DIMS), a third the storage, measured lossless in dimensions.test.ts.
 */
export const MEMENTO_EMBEDDING_MODEL: SupportedEmbeddingModel = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;

/**
 * How many dimensions of that model's vector mementos actually keep.
 *
 * text-embedding-3-* are MATRYOSHKA models: the information is front-loaded, so the first N components
 * are themselves a valid embedding. Truncating to N is exactly what OpenAI's `dimensions` parameter
 * does, and it is free here in a way that matters, because the vector is the dominant cost in this
 * system twice over - the ledger encrypts one per event and the fold pulls one per live belief across
 * the wire from a remote Mongo, and every memento stores one.
 *
 * 512 was measured, not guessed (b4m-core/memory/src/eval/dimensions.test.ts): against the full 1536 it
 * holds hit rate at 100%, MRR at 1.000, and the de-dup separation at +0.073 - identical on every axis -
 * for a THIRD of the bytes. Quality only starts to slip at 384 and the de-dup band narrows at 128.
 */
export const MEMENTO_EMBEDDING_DIMS = 512;

/**
 * The identity of the vector space mementos live in - and it is the MODEL PLUS THE WIDTH, because a
 * truncated vector is a different space, not a smaller version of the same one. Cosine between a
 * 1536-dim vector and a 512-dim one is not "less precise", it is undefined.
 *
 * This is what gets stamped on every stored vector, and stamping the model alone would be the exact
 * silent-outage bug this codebase has now hit twice: two vectors both honestly labelled
 * "text-embedding-3-small", one 1536 wide and one 512, compared against each other and scored on noise.
 * Widening or narrowing the vector therefore CHANGES THIS STRING, which makes every existing vector
 * read as stale (untrusted, not assumed) until the migration re-stamps it. That is the intended
 * behaviour, not an inconvenience.
 */
export const MEMENTO_EMBEDDING_ID = `${MEMENTO_EMBEDDING_MODEL}@${MEMENTO_EMBEDDING_DIMS}`;

/**
 * Take a full-width model vector into the memento vector space: truncate, then L2-normalize.
 *
 * The renormalization is what OpenAI's own `dimensions` parameter does after truncating. Cosine is
 * scale-invariant so it changes nothing for retrieval, but it keeps the stored vectors unit-norm - so
 * anything that ever reaches for a dot product gets the right answer instead of a subtly wrong one.
 *
 * EVERY memento path must funnel its vectors through here - both the stored fact and the query it is
 * scored against - or the two land in different spaces. A length mismatch does not throw; it scores 0,
 * which the topicality floor then silently discards. That failure looks exactly like "the user never
 * told us that".
 */
export function toMementoVector(full: readonly number[]): number[] {
  const truncated = full.slice(0, MEMENTO_EMBEDDING_DIMS);
  const norm = Math.sqrt(truncated.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? truncated.map(x => x / norm) : truncated;
}

/**
 * Topicality floor for memento retrieval: below this cosine to the query, a memento is not surfaced.
 *
 * THIS NUMBER IS A PROPERTY OF MEMENTO_EMBEDDING_ID - the model AND the width - not of the memory
 * system. It lives here, glued to the space it was measured in, because they are one decision and
 * changing either alone is a silent outage (ada-002 -> 3-small moved the scale down and left the old
 * 0.75 floor rejecting every memento in existence; 1536 -> 512 moved it back up).
 *
 * The rule: the strictest floor that still forgets NOTHING. A higher floor buys precision by dropping
 * something the user actually told us, and that trade is not ours to make silently.
 *
 * 0.25, measured against a REAL 182-fact user corpus with 167 LLM-generated queries (the synthetic
 * eval corpus in b4m-core/memory/src/eval is a proxy, and it lies in both directions - it said 0.35
 * was lossless):
 *
 *      floor   hit@10    negatives injected
 *      0.25     98.8%           0.4          <- shipped: the knee
 *      0.30     95.8%           0.1          <- costs ~5 real memories to avoid 0.3 stray facts
 *      0.40     89.8%           0.0
 *
 * And the finding that matters most: on real data the distributions OVERLAP. An unanswerable question
 * scores 0.3432 against its best fact, while the 5th percentile of genuine hits is 0.3349. There is no
 * clean separating floor - only a trade, and this one is priced deliberately: a stray fact is noise the
 * model can ignore, a forgotten one is a thing the user told us and we act as if they never did.
 *
 * Re-derive if the model OR the width moves. Do not trust the synthetic corpus alone to do it.
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
  memento.embeddingModel === MEMENTO_EMBEDDING_ID;

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
  // Ollama embedders run on the operator's own hardware: no per-token cost.
  // Explicit 0 (not absent) so getEmbeddingModelCost stays quiet instead of alarming.
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B]: 0,
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_4B]: 0,
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_8B]: 0,
  [OllamaEmbeddingModel.NOMIC_EMBED_TEXT]: 0,
  [OllamaEmbeddingModel.MXBAI_EMBED_LARGE]: 0,
  [OllamaEmbeddingModel.BGE_M3]: 0,
  [OllamaEmbeddingModel.SNOWFLAKE_ARCTIC_EMBED]: 0,
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
