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

/**
 * `FabFile.notes` marker for the OTHER half of the same kill switch: a re-chunk dropped before it
 * ran (#1676/#1681). Distinct from `CONVERGENCE_PAUSED_NOTE` because the damage is worse and the
 * wording has to say so - the producer resets a wave's chunk state BEFORE the messages are handled,
 * so a file halted here has NO chunks at all rather than chunks without vectors.
 *
 * Without a marker this state is invisible to every surface at once, which is the failure it exists
 * to prevent: `chunkCount: 0` with `error: null` reads as an image or a pending upload, so health
 * drops it from the denominator, convergence grades it `conformant` (its stale stamp still matches),
 * search does not withhold it because it is not "in flight", and the rescue sweep's own filter
 * passes over it. The file's passages are simply gone and nothing reports it.
 *
 * Same cross-layer reason as the constant above for living here: the queue handler writes it and
 * b4m-core's evaluators read it, and b4m-core cannot import from apps/client.
 */
export const CONVERGENCE_PAUSED_CHUNK_NOTE =
  'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
  'rebuilt when convergence resumes.';

/**
 * Same halt, but for a file that had NO passages to lose: the rescue sweep selects on
 * `chunkCount: 0` and never resets, so nothing was removed and the note above would state a
 * destruction that did not happen. The distinction is user-visible, not pedantry - `notes` is
 * surfaced to the file's owner, and the marker also drives the retrieval withhold's "partial
 * results" banner, which would otherwise name a file whose passages were never there.
 *
 * Discriminated by `chunkRebuildRequestedAt`, which `resetChunkStateByIds` stamps in the same write
 * that clears the rollups: non-null means a producer really did remove the passages, null means the
 * file arrived here already empty. `markConvergencePaused` (FabFileModel) picks between the two.
 *
 * In CONVERGENCE_PAUSED_NOTES with its sibling, so health, convergence and retrieval grade the two
 * identically - only the wording differs. That is the whole point of routing every reader through
 * `isConvergencePausedNote`.
 */
export const CONVERGENCE_PAUSED_UNCHUNKED_NOTE =
  'Chunking paused by the data-lake convergence kill switch - this file has no passages yet; they ' +
  'are built when convergence resumes.';

/**
 * `FabFile.chunkRebuildRequestedAt`: stamped by `resetChunkStateByIds` in the SAME write that
 * clears a file's chunk rollups, so "this file's passages are being rebuilt" can never be lost the
 * way the pair of steps that creates the state can be. The reset and the queue send are two
 * operations - kill the producer between them, or lose the consumer's marker write, and the file
 * sits at `chunkCount: 0` with `error: null` and `notes: ''`, a shape indistinguishable from an
 * image or a still-uploading row. It then drops out of lake health's denominator, out of the
 * convergence plan and out of the retrieval withhold at the same moment: every rollup says its
 * passages are gone, and nothing reports it.
 *
 * Deliberately NOT `CONVERGENCE_PAUSED_CHUNK_NOTE` pre-written by the producer, which is the obvious
 * fix and the wrong one: that marker means "halted, needs an administrator", so a file awaiting an
 * ORDINARY rebuild would read to every reader as permanently paused for the whole rebuild - search
 * would tell readers it does not return on its own, health would hard-fail P3, and "Rebuild
 * passages" would offer to repair a file that is already repairing. A flag that cries wolf on the
 * normal path is worse than the rare window it closes.
 *
 * So the two facts are distinct states, and the consumer UPGRADES one to the other: pending means
 * "in flight, returns on its own", the paused note means "halted, needs intervention". A LOST
 * upgrade therefore degrades to mislabelled-but-visible rather than invisible, which is the trade
 * this field exists to make - invisibility is the real harm, labelling is secondary.
 *
 * A dedicated field rather than a third `notes` string on purpose: `notes` already carries two
 * unrelated facts (the user's own note / NO_EXTRACTABLE_TEXT, and the kill-switch markers), so every
 * writer of it clobbers the others.
 *
 * Cleared by `commitFabFileChunks` (the rebuild landed) and by the chunk handler's pause write (the
 * rebuild was halted instead). A file carrying `error` is settled regardless - see
 * `isMemberIndexingInFlight`, which is where the precedence between these three lives.
 */
export function isChunkRebuildPending(requestedAt?: Date | string | null): boolean {
  return requestedAt !== null && requestedAt !== undefined && requestedAt !== '';
}

/**
 * How long a pending rebuild may go uncommitted before the "Rebuild passages" door treats it as
 * STRANDED and offers to re-drive it. Only the datastore read uses this - the pure evaluators have
 * no clock and deliberately keep grading such a file as in-flight rather than guessing.
 *
 * Derived from the chunk queue's 60-minute visibility timeout (infra/queues.ts): one redelivery is
 * an hour away, so anything under that would offer a repair for a message that is merely waiting.
 * Two timeouts is past the point where a live delivery explains the silence, and still well inside
 * the `dlq: { retry: 3 }` budget, so the door opens before the message would reach the DLQ.
 */
export const REBUILD_PENDING_STALE_MS = 2 * 60 * 60_000;

/**
 * Whether a file's `notes` marks it as stalled by the convergence kill switch, by either arm.
 * THE predicate every reader uses, so adding a third stall marker reaches health, convergence and
 * retrieval without three separate string comparisons drifting apart.
 */
export function isConvergencePausedNote(notes?: string | null): boolean {
  return CONVERGENCE_PAUSED_NOTES.includes(notes as (typeof CONVERGENCE_PAUSED_NOTES)[number]);
}

/**
 * Datastore mirror of `isConvergencePausedNote`, for a Mongo `notes: { $in: [...] }`. Exported so a
 * query and the in-memory predicate cannot drift: adding a third stall marker to this array reaches
 * both. Declared after the two constants it names so the function above can close over it.
 */
/**
 * The CHUNK arm's markers, as distinct from the vectorize arm's. A reader that means "this file has
 * no passages because the kill switch stopped the work that would have built them" keys on THIS,
 * not on CONVERGENCE_PAUSED_NOTES: a vectorize-paused file still has its passages, so folding the
 * two together would grade it as chunkless. That distinction is why the sites below were written
 * against the bare `CONVERGENCE_PAUSED_CHUNK_NOTE` in the first place; this is the same predicate
 * widened to the second chunk-arm marker rather than a new one.
 */
export const CONVERGENCE_PAUSED_CHUNK_NOTES = [
  CONVERGENCE_PAUSED_CHUNK_NOTE,
  CONVERGENCE_PAUSED_UNCHUNKED_NOTE,
] as const;

/** Whether a file's `notes` marks it as chunkless by either arm of the CHUNK half of the switch. */
export function isConvergenceChunkPausedNote(notes?: string | null): boolean {
  return CONVERGENCE_PAUSED_CHUNK_NOTES.includes(notes as (typeof CONVERGENCE_PAUSED_CHUNK_NOTES)[number]);
}

export const CONVERGENCE_PAUSED_NOTES = [
  CONVERGENCE_PAUSED_NOTE,
  CONVERGENCE_PAUSED_CHUNK_NOTE,
  CONVERGENCE_PAUSED_UNCHUNKED_NOTE,
] as const;
