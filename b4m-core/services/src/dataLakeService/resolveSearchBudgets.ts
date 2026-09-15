import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_CHUNKS_PER_FILE_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
  KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT,
  KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
  SEARCH_BUDGET_SETTING_KEYS,
  SettingScope,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import type { SemanticSearchBudgets } from './semanticDataLakeSearch';
import { resolveScopedSettingValues } from '../settings/resolveScopedSetting';

/**
 * The scan budgets the search engine consumes, plus the SERVE budget its callers need.
 *
 * `maxChunkChars` is deliberately not part of SemanticSearchBudgets: it governs how much of a
 * matched chunk reaches the model, which the engine has no say in, and putting it on the engine's
 * interface would hand it a field it never reads.
 */
export type ResolvedSearchBudgets = SemanticSearchBudgets & {
  /**
   * Characters of one matched chunk the serve path may emit. Derived from the chunk policy rather
   * than configured on its own, so a passage cannot be chunked larger than it can be served.
   */
  maxChunkChars: number;
  /** Passages `search_knowledge_base` serves when a model call omits `max_results` (#1955). */
  kbDefaultResults: number;
  /**
   * Approximate tokens of served passage text one `search_knowledge_base` call may emit. `0` = no
   * budget; the passage count above is then the only bound (pre-#1955 behavior).
   */
  kbResultTokenBudget: number;
  /**
   * Minimum cosine score a passage must clear, as a 0..1 FRACTION - the unit `minScore` takes all
   * the way down to `annVectorSearch`. Stored as an integer percent (`kbSearchMinRelevancePct`);
   * the /100 conversion lives here so exactly one place owns it. `0` = today's behavior.
   */
  kbMinRelevance: number;
  /**
   * Most chunks one source document may contribute to a search's top-K; `0` = no cap. Enforced
   * at whatever count the CALLER serves, which is not always the topK it asked for: the engine
   * applies it at its own topK, and a caller that ranks wider than it serves (the chat KB tool)
   * applies it a second time at its served ceiling. Declared
   * REQUIRED here even though `SemanticSearchBudgets` has it optional: the intersection narrows it,
   * so a resolution path that forgot to set it fails to compile instead of silently ignoring an
   * operator's configured cap - the failure mode a purely optional field would have hidden.
   */
  maxChunksPerFile: number;
};

/**
 * Read the operator-configured budgets for data-lake semantic search: how far to SCAN, how much of
 * a matched chunk to SERVE, and (#1955) how many passages and how relevant they must be for
 * `search_knowledge_base` specifically.
 *
 * Shared by both retrieval entrypoints - the search route (data-lakes/semantic-search) and the chat
 * KB tool - so neither derives its budget by hand. (Forced retrieval does NOT come through here: it
 * builds its own scoped read via resolveScopedSettingValues in ChatCompletionFeatures.)
 *
 * As of #2709 both entrypoints resolve on a CALLER scope rather than platform-only, so an org/owner
 * override moves both surfaces instead of just the chat one. That is why `scope` below is REQUIRED:
 * a platform-only read is still available, but only by passing an empty scope (`{}`, the idiom
 * lakeAdmissionGate already uses), never by omitting the argument. Two of the three call sites had
 * silently omitted it, which is the whole of #2709.
 *
 * The two entrypoints do NOT yet derive the org rung the same way, so equal budgets are not
 * guaranteed for a caller whose selected org is not one they belong to. The route verifies the
 * selected org against the caller's membership set (#1674) and drops the rung when it fails; the KB
 * tool passes `context.user.organizationId` through as-is, because ToolContext wires no repo that
 * could check membership. Closing that gap means threading one through the tool surfaces first.
 *
 * Uses the CACHED settings accessor, so this costs no round-trip on a warm cache.
 *
 * The serve budget is DERIVED from the chunk-size policy (`DefaultChunkSize`, the same row the
 * chunker reads as its passage target) rather than being a lever of its own. Two independently-set
 * numbers is what produced the defect this replaces: content was chunked to one size and clipped at
 * serve time by a smaller constant, so a full-size chunk lost roughly 40% of itself before the model
 * saw it, on every lake. See deriveServeCharBudget in @bike4mind/common.
 *
 * Never throws: a settings outage falls back to the coded defaults and warns. The warn matters
 * because the symptom of a bad value would otherwise be "retrieval quietly covers less than the
 * admin configured", which is indistinguishable from a small corpus.
 *
 * That warn fires only on the PLATFORM path, which since #2709 is not the path production takes:
 * `scopeForCaller` always sets an owner rung, so `scopeHasRung` is true for every authenticated
 * caller. On the scoped branch each key is read through `getSettingsValue`, which schema-parses the
 * stored row and substitutes the coded default on a failed parse, silently. For four of the seven
 * keys the schema bound is TIGHTER than the coercers below, so an out-of-range row does not just
 * lose the warn, it resolves to a DIFFERENT value than the platform path would: `DefaultChunkSize`
 * outside 64..1500, `kbSearchDefaultResults` above 10, `kbSearchResultTokenBudget` above 20000, and
 * `kbSearchMinRelevancePct` above 100 - where the two ends are opposite, an impassable floor on the
 * platform path against no floor at all on the scoped one (the end the chat tool has always been
 * on). One consequence to know before trusting it: the `pct > 100` guard in resolveRelevancePct
 * below is now unreachable on the dominant path. The admin write boundary enforces every one of
 * those bounds, so a divergent row takes a hand-edited document or one predating the constraint.
 * Closing the gap properly belongs with the scoped seam itself (#1662).
 *
 * Scope (epic #1658 lane 0 / #1660): a caller passes the org/owner a search runs for as `scope`,
 * plus the `scopedSettings` overlay repo, to let a narrower rung tighten the budget below the
 * platform ceiling. Org and Owner are the only rungs on offer: every key read here lost or
 * never had a Lake rung, because one search spans EVERY lake the caller can reach (#2624), so a
 * `scope.lakeId` reaching this function resolves nothing no matter what is stored against it.
 * Passing rungs WITHOUT the repo warns rather than resolving platform-only in silence - it is a
 * wiring mistake, since the two travel together. The chunk-policy rung rides this same seam and is
 * already live - `DefaultChunkSize` has been settable at Organization/Owner since #1722 - but it is
 * the ONE key here a narrower rung may only RAISE, never lower: see `resolveServeTarget` below for
 * why (#2803).
 */
export async function resolveSearchBudgets(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  },
  logger: Logger | undefined,
  scope: SettingScope
): Promise<ResolvedSearchBudgets> {
  const hasRung = scopeHasRung(scope);

  // Rungs with no store to read them from is a WIRING bug, not a platform read: the caller asked for
  // scoped budgets and would have got platform ones with no signal. Warn rather than resolve quietly -
  // silence here is the same failure #2709 found one level up, where the omission was the scope itself.
  // Once per process, for the reason the ceiling warn below is throttled: this states a WIRING fact,
  // and this resolver runs on every search of every turn.
  if (hasRung && !db.scopedSettings && !missingOverlayStoreWarned) {
    missingOverlayStoreWarned = true;
    logger?.warn?.(
      '[semanticSearch] scope carries override rungs but no scopedSettings store is wired; resolving platform-only'
    );
  }

  // Scoped path: only when a caller both supplies rungs and wires the overlay store. The resolver
  // falls back to the platform value per key, so an un-overridden budget matches the platform path.
  if (hasRung && db.scopedSettings) {
    try {
      const values = await resolveScopedSettingValues(SEARCH_BUDGET_SETTING_KEYS, scope, db, {
        logger,
      });
      const serveTarget = await resolveServeTarget(values.DefaultChunkSize, db, logger);
      return {
        maxFiles: positiveIntOr(
          values.dataLakeSearchMaxFiles,
          DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
          'dataLakeSearchMaxFiles',
          logger
        ),
        maxChunks: positiveIntOr(
          values.dataLakeSearchMaxChunks,
          DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
          'dataLakeSearchMaxChunks',
          logger
        ),
        maxChunkChars: resolveServeBudget(serveTarget, logger),
        kbDefaultResults: positiveIntOr(
          values.kbSearchDefaultResults,
          KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
          'kbSearchDefaultResults',
          logger
        ),
        kbResultTokenBudget: nonNegativeIntOr(
          values.kbSearchResultTokenBudget,
          KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
          'kbSearchResultTokenBudget',
          logger
        ),
        kbMinRelevance: resolveRelevancePct(values.kbSearchMinRelevancePct, logger),
        maxChunksPerFile: nonNegativeIntOr(
          values.dataLakeSearchMaxChunksPerFile,
          DATA_LAKE_SEARCH_MAX_CHUNKS_PER_FILE_DEFAULT,
          'dataLakeSearchMaxChunksPerFile',
          logger
        ),
      };
    } catch (err) {
      logger?.warn?.('[semanticSearch] scoped budget resolution failed; falling back to platform', err);
      // fall through to the platform path
    }
  }

  try {
    const values = await getSettingsByNames([...SEARCH_BUDGET_SETTING_KEYS], db, { logger });
    return {
      maxFiles: positiveIntOr(
        values.dataLakeSearchMaxFiles,
        DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
        'dataLakeSearchMaxFiles',
        logger
      ),
      maxChunks: positiveIntOr(
        values.dataLakeSearchMaxChunks,
        DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
        'dataLakeSearchMaxChunks',
        logger
      ),
      maxChunkChars: resolveServeBudget(values.DefaultChunkSize, logger),
      kbDefaultResults: positiveIntOr(
        values.kbSearchDefaultResults,
        KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
        'kbSearchDefaultResults',
        logger
      ),
      kbResultTokenBudget: nonNegativeIntOr(
        values.kbSearchResultTokenBudget,
        KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
        'kbSearchResultTokenBudget',
        logger
      ),
      kbMinRelevance: resolveRelevancePct(values.kbSearchMinRelevancePct, logger),
      maxChunksPerFile: nonNegativeIntOr(
        values.dataLakeSearchMaxChunksPerFile,
        DATA_LAKE_SEARCH_MAX_CHUNKS_PER_FILE_DEFAULT,
        'dataLakeSearchMaxChunksPerFile',
        logger
      ),
    };
  } catch (err) {
    logger?.warn?.('[semanticSearch] could not read scan-budget settings; using defaults', err);
    return {
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      // No configured target reached us, so the chunker's own default is the honest basis.
      maxChunkChars: deriveServeCharBudget(undefined).maxChunkChars,
      kbDefaultResults: KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
      kbResultTokenBudget: KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
      kbMinRelevance: KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100,
      maxChunksPerFile: DATA_LAKE_SEARCH_MAX_CHUNKS_PER_FILE_DEFAULT,
    };
  }
}

/**
 * The chunk-policy target the SERVE budget is derived from on the scoped path: the LARGER of the
 * caller-resolved rung and the platform value. A caller rung may only raise this, never lower it.
 *
 * `DefaultChunkSize` is a chunk-PRODUCTION policy whose declared subject is the file OWNER ("Resolves
 * at file-OWNER altitude", its definition in common), but a knowledge-base search spans other owners'
 * files, so for most of what it serves the caller is not that subject. The invariant the derivation
 * defends is one-sided - never clip a chunk the PRODUCING policy would make - so a budget ABOVE the
 * producing policy costs nothing, while one below it truncates in-policy content the caller does not
 * own. Taking the max is what separates the two: an owner's own high pin still governs their own
 * files (the case a platform-only read would regress), and a low pin reaches no one else (#2803).
 *
 * `deriveServeCharBudget` is monotonic non-decreasing in its target, so max-of-TARGETS equals
 * max-of-budgets - which is what keeps this ONE derivation rather than two serve caps, the thing
 * `chunking.ts` explicitly forbids adding.
 *
 * Residual, and why #2803 is narrowed rather than closed: a THIRD owner pinned above both the
 * platform and the caller is still served below their own policy. Only per-file resolution in the
 * serve loop fixes that; the per-file `maxChunkCharLength` rollup `lakeConvergence` already reads is
 * the seam it would hang off.
 *
 * Reads the platform row through the CACHED accessor, so on a warm cache this costs no round-trip.
 * Its own failure degrades to the coded default rather than propagating: the six scoped budgets
 * resolved alongside it are still good, and losing them to a platform-floor read would be a worse
 * trade than serving the default floor.
 */
async function resolveServeTarget(
  scopedChunkSize: string | number | null | undefined,
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: Logger
): Promise<number> {
  const scopedTarget = positiveIntOr(scopedChunkSize, DEFAULT_PASSAGE_TOKEN_TARGET, 'DefaultChunkSize', logger);
  try {
    const raw = platformChunkSizeRow(await getSettingsByNames(['DefaultChunkSize'], db, { logger }));
    // Labelled distinctly from the scoped row because the two can be unusable independently, and
    // WHICH one is bad is the whole content of the warn. Throttled per distinct row for the reason
    // the ceiling warn is: this states a CONFIG fact, and the scoped path - where it now fires, where
    // the set-but-unusable warn never used to - is the one production takes on every search of every
    // turn. Keying on the row rather than a boolean means a config CHANGE still warns again.
    const firstSighting = !warnedPlatformChunkRows.has(raw);
    warnedPlatformChunkRows.add(raw);
    const platformTarget = positiveIntOr(
      raw,
      DEFAULT_PASSAGE_TOKEN_TARGET,
      'platform DefaultChunkSize',
      firstSighting ? logger : undefined
    );
    return Math.max(scopedTarget, platformTarget);
  } catch (err) {
    // Near-unreachable: `resolveScopedSettingValues` has just read the same cached map for its own
    // per-key platform fallbacks, so a throw here means the cache went away between the two. Warned
    // once per process anyway - an outage that IS reachable would otherwise repeat per search.
    if (!platformChunkPolicyOutageWarned) {
      platformChunkPolicyOutageWarned = true;
      logger?.warn?.(
        '[semanticSearch] could not read the platform chunk policy for the serve floor; using default',
        err
      );
    }
    return Math.max(scopedTarget, DEFAULT_PASSAGE_TOKEN_TARGET);
  }
}

/**
 * The raw `DefaultChunkSize` row as a string key, so the warn throttle below can tell one stored
 * value from another. `null`/absent normalizes to `''`, which `positiveIntOr` treats as unset and
 * never warns about - so the unset case occupies one harmless slot rather than defeating the key.
 */
function platformChunkSizeRow(values: Record<string, string | null>): string {
  return values.DefaultChunkSize ?? '';
}

/**
 * Turn the configured chunk token target into the serve character budget, warning when the safety
 * ceiling leaves the cap below the configured chunk size - the residual case where the two still
 * disagree, and the one an operator has to be told about rather than discover as truncated answers.
 *
 * Takes `number` as well as `string` because the two paths hand it different shapes: the platform
 * read yields the raw stored string, while the scoped path arrives via `resolveServeTarget`, which
 * has already resolved both rows to a number. So the set-but-unusable warn below fires only on the
 * platform path - a bad row on the scoped path is warned about by `resolveServeTarget` instead, once
 * per row, which is what keeps "the caller's rung is unusable" distinguishable from "the platform's
 * is". `DefaultChunkSize` is also one of the four keys where the scoped path's schema coercion
 * changes the resolved value; see the resolver docblock above for which, and why.
 */
function resolveServeBudget(rawChunkSize: string | number | null | undefined, logger?: Logger): number {
  // Same parse-and-warn contract as the scan budgets: unset is normal and silent, set-but-unusable
  // warns and falls back to the chunker's own default - which is what the chunker does with it too.
  const target = positiveIntOr(rawChunkSize, DEFAULT_PASSAGE_TOKEN_TARGET, 'DefaultChunkSize', logger);
  const budget = deriveServeCharBudget(target);
  if (budget.ceilingBound && !ceilingWarnedTargets.has(budget.chunkTokenTarget)) {
    ceilingWarnedTargets.add(budget.chunkTokenTarget);
    logger?.warn?.(
      `[semanticSearch] chunk target ${budget.chunkTokenTarget} tokens exceeds the per-passage serve ceiling; ` +
        `serving ${budget.maxChunkChars} chars per chunk, so large chunks will be clipped`
    );
  }
  return budget.maxChunkChars;
}

/**
 * The ceiling warn states a CONFIG fact, not a per-request one, and this resolver sits on the hot chat
 * path (search runs up to MAX_SEARCHES times a turn, for every user). Warning on every call would bury
 * the signal in its own repetition, so it fires once per distinct token target per process. A config
 * change to a new value warns again, which is the only transition an operator needs to see.
 */
const ceilingWarnedTargets = new Set<number>();

/** Same once-per-process reasoning, for the missing-overlay-store warn at the top of the resolver. */
let missingOverlayStoreWarned = false;

/**
 * Distinct platform `DefaultChunkSize` rows already warned about, so an unusable one is reported once
 * rather than on every search. Keyed by the raw stored row (see `platformChunkSizeRow`) so a config
 * change warns again - the same contract, and for the same reason, as `ceilingWarnedTargets`.
 */
const warnedPlatformChunkRows = new Set<string>();

/** Same once-per-process reasoning, for the platform chunk-policy read outage in `resolveServeTarget`. */
let platformChunkPolicyOutageWarned = false;

/** Test-only: the limiters above are module state, so a test asserting one starts from a clean slate. */
export function resetBudgetWarnLimiters(): void {
  ceilingWarnedTargets.clear();
  missingOverlayStoreWarned = false;
  warnedPlatformChunkRows.clear();
  platformChunkPolicyOutageWarned = false;
}

function scopeHasRung(scope: SettingScope): boolean {
  return !!(scope.organizationId || scope.owner?.id || scope.lakeId);
}

/**
 * Shared body of `positiveIntOr` / `nonNegativeIntOr`, whose only difference is where the usable
 * range starts.
 *
 * `label` carries ALL the subsystem context in the message. These helpers are called from semantic
 * search AND from forced retrieval / lake memory (`ChatCompletionFeatures.ts`), so a hardcoded tag
 * would file half the warnings under the wrong subsystem during on-call triage. Pass the setting
 * key, so the warning greps straight back to the row an operator has to edit.
 */
function intAtLeastOr(
  raw: string | number | null | undefined,
  minimum: number,
  fallback: number,
  label: string,
  logger?: Logger
): number {
  // A whitespace-only row is a cleared field, not a value: `Number('  ')` is 0, and 0 is MEANINGFUL
  // for several callers, so without the trim a cleared field reads as a deliberate 0. Harmless
  // where the coded default is itself 0 (the kb* budgets), not harmless for the two
  // forced-retrieval floors in `ChatCompletionFeatures.ts`, whose defaults are 85 and 75 - there a
  // cleared row removes the floor instead of restoring it.
  //
  // This defends the PLATFORM read path, which hands the stored string through untouched. It CANNOT
  // defend the scoped path: `makeNumberSetting`'s `z.coerce.number()` has already turned '  ' into
  // the number 0 by the time the value arrives here, so there is no string left to trim. Closing
  // that needs a preprocess on the setting factory itself, which would move every number setting.
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    // The ORIGINAL `raw`, not the trimmed value, so the operator sees exactly what is stored.
    logger?.warn?.(`ignoring unusable ${label} setting ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * An unset setting is normal and silent; a set-but-unusable one is a misconfiguration worth saying.
 * Exported so other numeric-setting readers (e.g. forced retrieval's char budget in
 * `ChatCompletionFeatures.ts`) share this parse-and-warn contract instead of hand-rolling a copy.
 */
export function positiveIntOr(
  raw: string | number | null | undefined,
  fallback: number,
  label: string,
  logger?: Logger
): number {
  return intAtLeastOr(raw, 1, fallback, label, logger);
}

/**
 * Sibling of `positiveIntOr` for settings where `0` is a MEANINGFUL value, not an unusable one - a
 * disabled budget or an absent relevance floor. `positiveIntOr` cannot express this: it treats
 * anything below 1 as a misconfiguration and warns, which would fire on every search for a
 * legitimately-zero setting. Same contract otherwise: unset is silent, set-but-unusable warns and
 * falls back.
 */
export function nonNegativeIntOr(
  raw: string | number | null | undefined,
  fallback: number,
  label: string,
  logger?: Logger
): number {
  return intAtLeastOr(raw, 0, fallback, label, logger);
}

/**
 * `kbSearchMinRelevancePct` as a 0..1 fraction. The write-path schema already enforces `max: 100`
 * and the scoped-override path's own schema parse closes it too - this range check exists only for
 * a platform row written by any OTHER means (a hand-edited DB document, a stale row from before the
 * setting declared `max: 100`). Without it, a value like 500 would divide down to `minScore: 5.0`,
 * a cosine score no real match can ever clear, silently degrading every KB search to keyword-only
 * forever. `nonNegativeIntOr` stays generic (no upper bound - `kbSearchResultTokenBudget` reuses it
 * with a much larger, setting-specific ceiling), so the 100-cap and the /100 conversion live
 * together here, in the one place that already owns the unit conversion.
 *
 * Falls back to the coded default rather than clamping to 100. Clamping does not fix the failure,
 * it only shortens it: a `minScore` of 1.0 admits nothing but a perfect match, which starves
 * retrieval just as silently as the 5.0 would have. Only the coded default restores a working
 * floor. Kept identical to `forcedRetrievalFloorPct` in `ChatCompletionFeatures.ts`, which guards
 * the same hazard for the two forced-retrieval floors - if one changes, change both.
 */
function resolveRelevancePct(raw: string | number | null | undefined, logger?: Logger): number {
  const pct = nonNegativeIntOr(raw, KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT, 'kbSearchMinRelevancePct', logger);
  if (pct > 100) {
    logger?.warn?.(
      `[semanticSearch] kbSearchMinRelevancePct ${pct} exceeds 100; using ${KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT} instead`
    );
    return KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100;
  }
  return pct / 100;
}
