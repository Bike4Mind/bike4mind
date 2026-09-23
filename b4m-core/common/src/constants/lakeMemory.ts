/**
 * Lake-memory recall defaults, shared between the admin-settings schema in this package and
 * `ChatCompletionFeatures.ts` (which cannot import from `common`'s settings schema without a
 * dependency cycle, so the constant lives here instead - same reason `forcedRetrieval.ts` exists).
 */

/**
 * Beliefs the lake-memory hot-card may inject per turn, shared across every lake in scope.
 *
 * 8 was inherited verbatim from user-memento recall, where it is a sensible number of facts about
 * one person; lake memory is reference material extracted from a document corpus, and 8 one-liners
 * split across two or more lakes is very little grounding. 24 is deliberately a 3x raise rather
 * than a measured optimum - nothing has ever varied this - and it anchors on the sibling block's
 * size: at the 500-char per-fact cap in `buildLakeMemoryContext`, 24 beliefs is a ~12,000-char
 * worst case, the same order as `FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT` injected on the same turn.
 */
export const LAKE_RECALL_K_DEFAULT = 24;

/**
 * Write-time ceiling for the belief budget. Not a technical limit - `recall` will happily return
 * more - but a fat-fingered extra zero (24 -> 240) has the same failure mode the forced-retrieval
 * budget's `max` exists to stop: nothing rejects the value, and the oversized system block is not
 * something the overflow-guard safety net can shed. `dropOldestHistoryTurn` only ever slices
 * conversation turns, so the turn silently loses history and then hard-errors once fewer than two
 * turns remain - a symptom that looks nothing like a misconfigured setting.
 *
 * 200 x the 500-char per-fact cap in `buildLakeMemoryContext` is ~100,000 chars, matching
 * `forcedRetrievalCharBudget`'s own declared ceiling for the retrieval block alongside it. Cards
 * render undated today, so nothing is added per fact; were the `(document dated YYYY-MM-DD)` suffix
 * ever populated the block would run a few percent over that figure - the ceiling is the order of
 * magnitude, not a byte budget.
 */
export const LAKE_RECALL_K_MAX = 200;

/**
 * Prefix marking a ledger `sources` entry that is PROVENANCE rather than a source document.
 *
 * Every other writer puts bare FabFile ids in a memory event's `sources`, and three readers lean on
 * that: `createReachableSourcesResolver` and `createSurvivingSourcesResolver` resolve each id
 * against the FabFile collection, and `aggregateLakeMemoryCoverage` counts the distinct union as
 * "source documents". A curator's resolution belief (#3049) also has to name the FINDING it came
 * from, which is not a document - so it goes in prefixed, and every one of those readers filters the
 * prefixed entries back out with `isDocumentSource`.
 *
 * The prefixed id is HARMLESS to correctness wherever it leaks through - it simply resolves to
 * nothing, and a finding's own document ids ride in the same array so the belief stays citable on
 * those. It is filtered anyway because "harmless" is not free: the FabFile lookups run it through an
 * ObjectId-only guard that logs `skipping ids that cannot address a row by _id` on every lake recall
 * turn and every profile read, which is noise that looks like a bug for as long as anyone chases it.
 *
 * Shred is the one path that must NOT filter: `markSourceShredded` matches an exact string, so the
 * prefixed ref is usable as the key that retracts a belief when its finding goes away. Nothing wires
 * that up today - no caller passes a `finding:` id to `markSourceShredded`, which is keyed on
 * FabFile ids throughout - so this is a door that COULD be opened, not one that is.
 *
 * MUST STAY IN SYNC with the `$filter` in `MemoryLedgerEventModel.aggregateLakeMemoryCoverage`,
 * which cannot import this predicate into an aggregation pipeline and restates the prefix test in
 * Mongo operators instead - `aggregateLakeMemoryCoverage`'s cases in `MemoryLedgerEventModel.test.ts`
 * pin the two together against a real Mongo.
 */
export const LAKE_MEMORY_FINDING_SOURCE_PREFIX = 'finding:';

/** The `sources` entry naming the finding a belief was decided on. */
export const findingSourceRef = (findingId: string): string => `${LAKE_MEMORY_FINDING_SOURCE_PREFIX}${findingId}`;

/**
 * Whether a `sources` entry names a SOURCE DOCUMENT rather than provenance.
 *
 * The one predicate every FabFile-resolving reader of a belief's `sources` filters on, so that
 * "which of these is a document id?" has a single answer. Adding a second provenance prefix should
 * mean editing this and nothing else.
 */
export const isDocumentSource = (sourceId: string): boolean => !sourceId.startsWith(LAKE_MEMORY_FINDING_SOURCE_PREFIX);
