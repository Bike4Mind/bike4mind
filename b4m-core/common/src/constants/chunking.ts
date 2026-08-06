/**
 * Passage-chunking limits, in TOKENS.
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
