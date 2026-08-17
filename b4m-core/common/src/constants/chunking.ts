/**
 * Passage-chunking limits, in TOKENS, plus the SERVE-side character budget derived from them.
 *
 * The two halves live together because they must agree: the retrieval path used to clip served
 * passages at a character constant of its own, unaware of the token target the chunker had been
 * given, so a full-size chunk lost a large fraction of itself on the way to the model. Deriving one
 * from the other (deriveServeCharBudget) is what keeps that from recurring - do not add a second,
 * independently-configured serve cap anywhere.
 *
 * These live in `common` rather than next to `SmartChunker` because the values are needed by three
 * layers that cannot all reach the chunker: the admin-settings schema in this package (importing
 * `fab-pipeline` from here would be a dependency cycle - `fab-pipeline` depends on `common`), the
 * React settings controls (`fab-pipeline`'s chunk module pulls in mammoth, JSZip, tiktoken, unpdf
 * and the S3 client, none of which belong in a browser bundle), and the chunker itself.
 *
 * Before this existed the number was hand-copied into all of them and had already drifted four ways
 * - the schema default said 2100, two UI fallbacks said 2000, and the chunker said 512 - so a
 * reprocess driven through the UI produced chunks about 4x the intended size and read as the
 * passage-chunking work underdelivering. Import from here; do not re-declare.
 */

/**
 * Default soft cap on chunk size, in tokens. Retrieval quality is the reason this exists:
 * without it, chunks grow to the embedding model's context window (~6.5K tokens / ~26KB of
 * prose), so one vector averages a whole document and cosine ranking cannot discriminate a
 * specific fact from the rest of the file. ~512 tokens is passage granularity: large enough
 * to carry a coherent idea, small enough that the vector is about one thing.
 */
export const DEFAULT_PASSAGE_TOKEN_TARGET = 512;

/** Floor for caller-supplied passage targets; below this, chunks lose usable context. */
export const MIN_PASSAGE_TOKEN_TARGET = 64;

/**
 * Model-INDEPENDENT sanity ceiling for a configured passage target, in tokens. A passage larger
 * than a full typical embedding context window (~8K) defeats retrieval granularity - one vector
 * would average a whole document (see DEFAULT_PASSAGE_TOKEN_TARGET).
 *
 * CURRENTLY UNREFERENCED. It bounded the scoped `DefaultChunkSize` setting until #1804 lowered that
 * ceiling to OVERSIZED_PASSAGE_TOKEN_THRESHOLD - a configured target above the detection threshold
 * makes "Rebuild passages" non-convergent, which is a tighter constraint than this one. Deliberately
 * kept rather than deleted: it states a real invariant (a passage should not approach a whole
 * embedding window) that a future non-lake caller may need, and deleting an exported symbol from
 * `common` is the shape that passes public CI and breaks an overlay at deploy time.
 *
 * NOT enforced downstream in this value: `effectiveChunkTokenLimit` (fab-pipeline) clamps to the
 * EMBEDDING MODEL's window, which is a different and model-dependent bound. Nothing enforces 8192.
 */
export const MAX_PASSAGE_TOKEN_TARGET = 8192;

/**
 * A chunk larger than this (in tokens) marks a file whose chunking predates the passage-target
 * fix: a whole-document / whole-section blob rather than a ~512-token passage. Used to detect the
 * files a lake "Rebuild passages" pass should re-chunk. Deliberately well above
 * DEFAULT_PASSAGE_TOKEN_TARGET (512) so a correctly-chunked passage never trips it, and below the
 * ~6.5K model-window packing the old chunker produced, so every legacy blob does.
 */
export const OVERSIZED_PASSAGE_TOKEN_THRESHOLD = 1500;

/**
 * Characters per token used to turn a chunk's TOKEN target into the SERVE path's CHARACTER budget.
 *
 * Deliberately an upper bound, not the ~4 chars/token average for English prose. The number exists
 * to guarantee an invariant - the serve path never clips a chunk the chunk policy would produce -
 * and an average satisfies that for only about half of in-policy chunks by construction. The
 * expensive direction is text whose tokens each carry many characters (indentation and whitespace
 * runs, padded markdown tables, long common words); dense alphanumeric runs go the other way,
 * tokenizing into MORE tokens per character, so they are not the risk case.
 *
 * Not derived from the real tokenizer on purpose: ITokenizer exposes countTokens/encodeTokens with
 * no decode, so there is no way to clip on a token boundary and reassemble the text, and tokenizing
 * every served passage would land on the hot chat path (KB search runs up to 3x per turn).
 */
export const CHARS_PER_TOKEN_SERVE_BOUND = 6;

/**
 * Never serve less than this, whatever the chunk policy says. Equal to the historical hard-coded
 * serve cap, so no existing configuration can be made worse by deriving the budget instead.
 */
export const SERVE_CHUNK_CHARS_FLOOR = 1200;

/**
 * Hard rail on one passage's characters, so a very large configured chunk target cannot turn a
 * multi-passage search result into an unbounded context bill. The value was chosen to equal the
 * retrieve tool's per-request default (`DEFAULT_MAX_CHARS` in
 * `services/src/llm/tools/implementation/knowledgeBaseRetrieve/index.ts`) on the principle that a
 * single PASSAGE should not out-spend what a whole DOCUMENT retrieve returns by default. That is the
 * rationale for the number, not an invariant anything enforces - the two are free to diverge, and
 * this comment names the counterpart so a future reader can find it. When this binds, the cap is
 * below the configured chunk size - the very disagreement this module exists to remove - so the
 * resolver that applies it must say so rather than clip in silence.
 */
export const SERVE_CHUNK_CHARS_CEILING = 8000;

export interface ServeCharBudget {
  /** Characters of one chunk the serve path may emit before it has to clip. */
  maxChunkChars: number;
  /** The token target the budget was derived from, after the chunker's own clamp. */
  chunkTokenTarget: number;
  /** True when SERVE_CHUNK_CHARS_CEILING clamped the derivation, i.e. the cap is BELOW the policy. */
  ceilingBound: boolean;
}

/**
 * Derive the per-chunk serve budget from the chunk policy, so the two cannot disagree.
 *
 * The input clamp mirrors SmartChunker's own (fab-pipeline `chunk.ts`): an unusable or absent target
 * means the chunker default applies, and a below-floor target is raised, not honored. Keep the two
 * clamps in sync or the serve path will size itself against a target the chunker never used.
 */
export function deriveServeCharBudget(chunkTokenTarget?: number | null): ServeCharBudget {
  const target =
    typeof chunkTokenTarget === 'number' && Number.isFinite(chunkTokenTarget) && chunkTokenTarget > 0
      ? Math.max(Math.floor(chunkTokenTarget), MIN_PASSAGE_TOKEN_TARGET)
      : DEFAULT_PASSAGE_TOKEN_TARGET;
  const derived = target * CHARS_PER_TOKEN_SERVE_BOUND;
  return {
    maxChunkChars: Math.min(Math.max(derived, SERVE_CHUNK_CHARS_FLOOR), SERVE_CHUNK_CHARS_CEILING),
    chunkTokenTarget: target,
    ceilingBound: derived > SERVE_CHUNK_CHARS_CEILING,
  };
}

/**
 * `FabFile.notes` marker written when the data-lake convergence kill switch abandons a vectorize
 * (#1676). The file keeps its chunks but has no vectors, so it is unsearchable until re-indexed, and
 * it does NOT auto-resume.
 *
 * Lives here rather than beside its writer (apps/client fabFileVectorize) because it is a
 * cross-layer contract: the queue handler writes it and the lake-health evaluator
 * (constants/lakeHealth.ts) reads it to tell a permanently-stalled file from one still in flight.
 * b4m-core cannot import from apps/client, so a copy there would have to drift silently.
 */
export const CONVERGENCE_PAUSED_NOTE =
  'Indexing paused by the data-lake convergence kill switch - reprocess to complete.';
