import { ToolContext, ToolDefinition } from '../../base/types';
import {
  CitableSource,
  describePipelineStall,
  getEmbeddingModelCost,
  IFabFileDocument,
  isSupportedEmbeddingModel,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  createTokenizer,
  getProviderFromModel,
  getSettingsByNames,
  resolveEmbeddingConfig,
  type ITokenizer,
} from '@bike4mind/utils';
import { filterRetrievalExcluded } from '@bike4mind/utils/retrievalExclusion';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import type { Logger } from '@bike4mind/observability';
import { resolveSessionLakeAccess } from '../../base/resolveSessionLakeAccess';
import { lakeMembershipsFrom, warnIfManyLakeMemberships } from '../../../../dataLakeService/getDynamicDataLakeTags';
import { datalakeTagsFrom } from '../../../../dataLakeService/getDataLakePrompts';
import {
  defangRetrievedContent,
  renderRetrievedContentBlock,
  toContentLabel,
} from '../../../../dataLakeService/renderRetrievedContentBlock';
import { prependRetrievedLakePrompts } from '../retrievedLakePrompts';
import { GROUNDED_NO_INVENTION_RULE } from '../../../prompts';
import { PARTIAL_RESULTS_STATUS_SUFFIX } from '../../../../dataLakeService/embeddingMismatch';
import { describeSearchLimitations } from '../../../../dataLakeService/retrievalUnavailable';
import {
  comparedNoPassages,
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  SemanticChunkResult,
  type SemanticDataLakeSearchResult,
  type SemanticSearchScanAccounting,
} from '../../../../dataLakeService/semanticDataLakeSearch';
import type { RetrievalSummary } from '../../retrievalSummaryMerge';
import { resolveSearchBudgets, type ResolvedSearchBudgets } from '../../../../dataLakeService/resolveSearchBudgets';
import { scopeForCaller } from '../../../../settings/resolveScopedSetting';
import { openSearchChunkAdapter } from '../../../../dataLakeService/openSearchChunkAdapter';
import { attributeAccessedLakeIds, type AttributableLake } from '../../../../dataLakeService/attributeAccessedLakes';
import { recordLakeAccessEvent } from '../../../../dataLakeService/recordLakeAccessEvent';
import { getEffectiveLLMApiKeys } from '../../../../apiKeyService';
import { recordOperationalUsage } from '../../../../billing';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { boundPassagesByTokenBudget, servedPassageText } from './tokenBudget';

// One tiktoken tokenizer for the whole module: KB search fires up to 3x per turn on
// the hot chat path, and a fresh tokenizer would throw away its encoder cache each call.
let sharedTokenizer: ITokenizer | undefined;
function getSharedTokenizer(logger: Logger): ITokenizer {
  if (!sharedTokenizer) sharedTokenizer = createTokenizer({ logger });
  return sharedTokenizer;
}

/** Clean "[Category] 01 Some Name.md" -> "Some Name" for display. */
function prettyFileName(fn: string): string {
  return fn
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^\d+[\s._-]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/**
 * Format semantic passages WITH their content so the model can answer without retrieving.
 *
 * Passage text is untrusted: a lake can serve content its owner did not author (a shared source
 * folder, research-driven acquisition), so every passage rides inside the delimited block and has
 * its line-initial markers defanged. Our own framing - the notices below and the preamble - stays
 * OUTSIDE the block at column 0, which is what makes the two distinguishable.
 *
 * `maxChunkChars` comes from resolveSearchBudgets, which derives it from the chunk-size policy. It is
 * not a constant here on purpose: a serve cap set independently of the chunk size WILL disagree with
 * it, and the disagreement is invisible - every full-size passage arrives pre-truncated and the model
 * answers from a fraction of what the lake stores. Clipping now only fires on chunks larger than the
 * current policy would produce (legacy content from a coarser chunker), and says so when it does.
 *
 * `bounding` (#1955) is set when a token budget stopped short of returning every ranked passage -
 * distinct from `scan.truncated` (how much of the CORPUS was searched) and `skipNotice` (whether what
 * was reached could be COMPARED): this says some of what was found and compared was still withheld to
 * stay within budget, which the model must not read as "nothing further exists".
 */
function formatSemanticResults(
  results: SemanticChunkResult[],
  maxChunkChars: number,
  scan?: SemanticSearchScanAccounting,
  skipNotice?: string | null,
  logger?: Logger,
  bounding?: { budgetBound: boolean; droppedCount: number }
): string {
  let clippedCount = 0;
  let longestChars = 0;
  const blocks = results.map((r, i) => {
    // Measured AFTER trim on purpose: the budget governs what this function emits, and the trimmed
    // string is what it emits. A padded chunk that fits once trimmed is served whole, correctly.
    longestChars = Math.max(longestChars, r.chunkText.trim().length);
    const { text, clipped } = servedPassageText(r, maxChunkChars);
    if (clipped) clippedCount++;
    // The file name is content-adjacent and equally attacker-influenced: without toContentLabel a
    // crafted name carries a newline plus a forged marker into the label line.
    return `${i + 1}. **${toContentLabel(prettyFileName(r.fileName))}** (relevance ${r.score.toFixed(2)})\n` + text;
  });
  // One line per call, not per passage: this runs on the hot chat path up to MAX_SEARCHES times a
  // turn. Silence here was the reason a lake could deliver a fraction of its content indefinitely
  // without anything to grep for, so the counts and the longest passage are both named.
  if (clippedCount > 0) {
    logger?.warn(
      `📚 [semantic] clipped ${clippedCount}/${results.length} passage(s) at ${maxChunkChars} chars ` +
        `(longest ${longestChars}); these chunks exceed the current chunk policy and should be reprocessed`
    );
  }
  // A truncated scan ranked only part of the corpus. Say so, or the model will read "no further
  // matches" into what is really "we stopped looking" and assert the library holds nothing else.
  // filesScanned + annFilesQueried, not filesScanned alone: an Atlas-served file was searched too,
  // just never handed to the brute-force scan (see SemanticSearchScanAccounting.annFilesQueried).
  const partial = scan?.truncated
    ? `NOTE: this search covered only ${scan.filesScanned + scan.annFilesQueried} of ${scan.filesMatching} documents (a scan budget was reached), so these passages may be incomplete. Do not state or imply the knowledge base has nothing further on this topic.\n\n`
    : '';
  // Distinct from the note above: that one says how much of the corpus was reached, this says that a
  // passage which WAS reached arrived incomplete. Composed here at column 0, deliberately outside the
  // untrusted block - inside it, defangRetrievedContent would indent our own notice.
  const clippedScope =
    clippedCount === results.length
      ? results.length === 1
        ? 'The passage'
        : `All ${results.length} passages`
      : `${clippedCount} of the ${results.length} passages`;
  const truncated =
    clippedCount > 0
      ? `NOTE: ${clippedScope} below ${clippedCount === 1 ? 'was' : 'were'} truncated at ${maxChunkChars} characters, so ${clippedCount === 1 ? 'it shows' : 'each shows'} only its opening. Do not treat a truncated passage as the document's full content; call retrieve_knowledge_content for the rest of a file you need to quote or reason over precisely.\n\n`
      : '';
  // Distinct again: the notes above are about corpus coverage and passage completeness; this one
  // (#1955) is about BREADTH - passages that matched and were fully served, but were still cut off
  // the response to stay inside the configured token budget.
  const budgetNote =
    bounding?.budgetBound && bounding.droppedCount > 0
      ? `NOTE: ${bounding.droppedCount} further relevant passage(s) matched but were not included, to stay within a configured retrieval budget. Do not state or imply the knowledge base has nothing further on this topic; call retrieve_knowledge_content for a specific file if you need more.\n\n`
      : '';
  return (
    formatSkipNotice(skipNotice) +
    partial +
    truncated +
    budgetNote +
    `Found ${results.length} relevant passage(s) in the knowledge base \u2014 the content is included below, so answer directly and only call retrieve_knowledge_content if you need MORE detail from a specific file:\n\n` +
    `${GROUNDED_NO_INVENTION_RULE}\n\n` +
    renderRetrievedContentBlock(blocks)
  );
}

/**
 * The tool's return string is the ONLY channel the model reads (statusUpdate reaches the UI, not
 * the conversation), so a comparability notice has to be part of it. Distinct from the scan note
 * above: that one says how much of the corpus was REACHED, this says whether what was reached
 * could be COMPARED. Phrased as an instruction because a bare fact tends to be paraphrased into a
 * claim of completeness.
 */
function formatSkipNotice(skipNotice?: string | null): string {
  if (!skipNotice) return '';
  return `NOTE: ${skipNotice} Tell the user the knowledge base may be returning partial results.\n\n`;
}

/**
 * Resolve the embedding model and provider keys the semantic paths need. Returns null when
 * any dep is missing/unconfigured (caller falls back to keyword search). Shared by the
 * unscoped and agent-scoped semantic arms so provider handling can never drift between them.
 */
async function resolveEmbeddingContext(context: ToolContext): Promise<{
  embeddingModel: SupportedEmbeddingModel;
  provider: string;
  apiKeyTable: Awaited<ReturnType<typeof getEffectiveLLMApiKeys>>;
  vectorSearchEnabled: boolean;
} | null> {
  const adminSettings = context.db.adminSettings;
  const apiKeys = context.db.apiKeys;
  if (!adminSettings || !apiKeys) {
    context.logger.warn(
      `📚 [semantic] falling back to keyword search: ${!adminSettings ? 'adminSettings' : 'apiKeys'} adapter not wired`
    );
    return null;
  }

  const modelRaw = await adminSettings.getSettingsValue('defaultEmbeddingModel');
  if (!modelRaw || !isSupportedEmbeddingModel(modelRaw)) {
    context.logger.warn(
      `📚 [semantic] falling back to keyword search: ${!modelRaw ? 'no defaultEmbeddingModel configured' : `unsupported defaultEmbeddingModel "${modelRaw}"`}`
    );
    return null;
  }
  const embeddingModel = modelRaw as SupportedEmbeddingModel;

  const apiKeyTable = await getEffectiveLLMApiKeys(
    context.userId,
    { db: { apiKeys, adminSettings }, getSettingsByNames },
    { logger: context.logger }
  );
  const provider = getProviderFromModel(embeddingModel);
  // A missing credential means the semantic arm cannot run, so fall back to keyword search.
  // Keyless providers (Bedrock, authenticating through the AWS credential chain) report
  // nothing missing and proceed.
  if (resolveEmbeddingConfig(provider, apiKeyTable).missing) {
    context.logger.warn(`📚 [semantic] falling back to keyword search: no credential for provider "${provider}"`);
    return null;
  }

  const vectorSearchEnabled = (await adminSettings.getSettingsValue('EnableDataLakeVectorSearch')) ?? false;

  return { embeddingModel, provider, apiKeyTable, vectorSearchEnabled };
}

/**
 * Bill the query-embedding spend for one model (the embed ran regardless of hit count).
 * `organization` is resolved once by the caller and passed in, not re-fetched per model.
 * Isolated so a recording failure never discards a good search result, and one model's failure
 * never skips another's.
 */
async function recordEmbeddingUsage(
  context: ToolContext,
  organization: Awaited<ReturnType<NonNullable<ToolContext['db']['organizations']>['findById']>> | null,
  query: string,
  embeddingModel: SupportedEmbeddingModel,
  provider: string
): Promise<void> {
  try {
    const queryTokens = await getSharedTokenizer(context.logger).countTokens(query, embeddingModel);
    await recordOperationalUsage(
      {
        requestId: context.sessionId ?? context.userId,
        user: context.user,
        organization,
        sessionId: context.sessionId,
        feature: 'embedding',
        provider,
        model: embeddingModel,
        inputTokens: queryTokens,
        costUsd: getEmbeddingModelCost(embeddingModel, queryTokens),
        source: 'system',
      },
      { db: { usageEvents: context.db.usageEvents, adminSettings: context.db.adminSettings }, logger: context.logger }
    );
  } catch (recordErr) {
    context.logger.warn(`📚 [semantic] failed to record embedding usage for ${embeddingModel}:`, recordErr);
  }
}

/**
 * Bill the primary model plus every alternate model the mixed-model ANN cutover actually embedded
 * under - each alternate embed ran (and is billable) regardless of whether its ANN query then
 * found anything. Resolves `organization` once (not per model) and fires every billing call
 * concurrently; each is independently try/caught inside recordEmbeddingUsage.
 *
 * The organization lookup itself is also try/caught here (not left to the caller's own
 * try/catch): both call sites wrap their entire semantic arm in a try/catch that falls through to
 * keyword search on ANY throw, so an unguarded lookup failure here would discard an already-
 * successful search result instead of just skipping its billing.
 */
async function recordAllEmbeddingUsage(
  context: ToolContext,
  query: string,
  primaryModel: SupportedEmbeddingModel,
  primaryProvider: string,
  alternateModelsEmbedded: string[]
): Promise<void> {
  let organization: Awaited<ReturnType<NonNullable<ToolContext['db']['organizations']>['findById']>> | null = null;
  try {
    organization =
      context.user.organizationId && context.db.organizations
        ? await context.db.organizations.findById(context.user.organizationId)
        : null;
  } catch (orgErr) {
    context.logger.warn('📚 [semantic] failed to resolve organization for embedding usage recording:', orgErr);
    return;
  }
  const models: Array<{ model: SupportedEmbeddingModel; provider: string }> = [
    { model: primaryModel, provider: primaryProvider },
    // Defensive: the planner (alternateModelAnn.ts) already only ever selects a registry-known
    // model, so this filter should never actually drop anything.
    ...alternateModelsEmbedded
      .filter(isSupportedEmbeddingModel)
      .map(model => ({ model, provider: getProviderFromModel(model) })),
  ];
  await Promise.all(
    models.map(({ model, provider }) => recordEmbeddingUsage(context, organization, query, model, provider))
  );
}

/**
 * Emit citable chips + a found-status line for semantic hits. corpusLabel keeps the scoped
 * wording free of owner-corpus framing ("the data lake" would misdescribe - and leak the
 * existence of - a corpus an agent-scoped caller cannot see).
 */
async function emitSemanticCitables(
  context: ToolContext,
  ranked: SemanticChunkResult[],
  corpusLabel: string,
  skipNotice?: string | null,
  dataLakeTags: string[] = []
): Promise<void> {
  // Citables - dedup to one chip per file (multiple chunks can match the same article)
  const seenFile = new Set<string>();
  const citables: CitableSource[] = [];
  for (const r of ranked) {
    if (seenFile.has(r.fileId)) continue;
    seenFile.add(r.fileId);
    citables.push({
      id: r.fileId,
      type: 'document',
      title: r.fileName,
      url: `/opti?mode=datalake&article=${r.fileId}`,
      description:
        r.fileTags
          .filter(t => !t.startsWith('datalake:'))
          .slice(0, 4)
          .join(', ') || undefined,
      timestamp: new Date().toISOString(),
      status: 'complete',
      metadata: { sourceSystem: 'knowledge_base', tags: r.fileTags, relevanceScore: r.score },
    });
  }
  const names = citables.slice(0, 3).map(c => prettyFileName(c.title));
  const more = citables.length > 3 ? ` +${citables.length - 3} more` : '';
  // Appended to the one found-status rather than a second update, which would read as a bug.
  // warnings also accretes onto promptMeta so the notice survives in the quest record.
  const partial = skipNotice ? PARTIAL_RESULTS_STATUS_SUFFIX : '';
  await context.statusUpdate(
    // any: statusUpdate takes a Partial<IChatHistoryItemDocument>; promptMeta's generated type
    // does not narrow to this literal. Pre-existing pattern in this file.
    {
      promptMeta: {
        citables,
        ...(skipNotice ? { warnings: [skipNotice] } : {}),
        retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags },
      },
    } as any,
    `📄 Found ${citables.length} relevant doc(s) in ${corpusLabel}: ${names.join(', ')}${more}${partial}`
  );
}

/**
 * What a semantic arm reports back. `output` is the formatted answer, or null to fall through to
 * keyword search. `skipNotice` is carried SEPARATELY so it survives that fall-through: when every
 * matching file was withheld the arm has no output at all, and without this the keyword answer
 * would reach the model with no hint that part of the corpus could not be compared.
 * `datalakeTags` is the `datalake:` provenance of the returned passages, driving retrieval-scoped
 * lake-prompt injection (#1108); it is EMPTY for the agent-scoped arm, which must never inject.
 */
interface SemanticArmResult {
  output: string | null;
  skipNotice: string | null;
  datalakeTags: string[];
  /** Files this arm actually matched, for attachmentInlineNotice - see its call site. Empty
   *  whenever `output` is null (nothing matched, or the arm never ran). */
  fileHits: Array<{ id: string; fileName: string }>;
  /** Lake ids attributed from the matched files' tags, for the access-event audit.
   *  Always empty for the agent-scoped arm, which never consults lake access at all. */
  lakeIds: string[];
  /** Chunk ids of the matched passages, for the same audit event. */
  chunkIds: string[];
  /** Per-chunk similarity score, index-aligned with `chunkIds` - required (not optional) so
   *  every construction site must supply it, including the empty-result ones below. */
  scores: number[];
  /**
   * What this arm PROVED about the corpus for `promptMeta.retrieval.outcome`, or null when it
   * proved nothing either way. Carried separately for the same reason `skipNotice` is: on a turn
   * the semantic arm returns no output for, the keyword arm's write is the only one this surface
   * makes, so a verdict left here would never be recorded.
   */
  retrievalOutcome: ProvenRetrievalOutcome | null;
}

/**
 * The outcomes a semantic arm can prove, derived from the schema's enum so a new outcome has to be
 * placed here rather than silently falling outside it. Neither excluded member is reachable: 'ok'
 * writes itself via emitSemanticCitables when passages come back, and 'no_lakes' is decided by the
 * no-corpus guards that return before a search runs.
 */
type ProvenRetrievalOutcome = Exclude<RetrievalSummary['outcome'], 'ok' | 'no_lakes'>;

/**
 * The retrieval verdict a completed semantic search proves, or null when it proves nothing and the
 * keyword arm's 'ok' should stand. Shared by both arms so the taxonomy is decided once rather than
 * at each of the write sites that ultimately stamp it.
 *
 * Only ever called on the zero-results path. Non-empty results imply something was scored, so both
 * branches below are already false there.
 *
 * The optional reads mirror `search.alternateModelsEmbedded ?? []` at the call sites: both fields
 * are required on the service's return type, so a real caller always supplies them, and the
 * tolerance only guards a test double built from a partial result object. A double that omits the
 * counters therefore keeps the pre-existing 'ok' rather than inventing a verdict from absence.
 */
function proveRetrievalOutcome(search: SemanticDataLakeSearchResult): ProvenRetrievalOutcome | null {
  // The embedder failing is not an indexing gap. Nothing was compared either way, but the remedy
  // is fixing the outage and never re-vectorizing content, which is precisely the line
  // RetrievalSummarySchema draws between 'failed' and 'not_indexed'. Forced retrieval reaches the
  // same verdict for free (generateEmbedding throws and its catch records 'failed'); this path
  // returns an empty-vector report instead of throwing, so it has to be mapped by hand.
  if (search.embeddingMismatch?.queryEmbeddingFailed) return 'failed';
  // Files WERE in scope and not one of their passages was compared against the query. Parity with
  // forced retrieval's `scoredCount === 0` exit, and the same reasoning: whether the cause is an
  // unvectorized corpus, a wholly foreign-model one or a lake the kill switch emptied, the library
  // was not searched, and reporting that as a topical zero claims it was.
  //
  // The scope guard is what keeps this off the abstain cases. An empty scope also compares nothing,
  // but "no document was in scope" is an access/config state rather than evidence about the corpus
  // - forced retrieval buckets it as 'no_lakes', and this surface's own no-corpus guards return
  // before a search is ever run, so the honest answer here is to leave their verdict alone.
  //
  // Deliberately NOT keyed on `skipNotice` or on either report's `partial`, both of which look
  // right and are not: `skipNotice` folds in the relevance-floor case, where a genuinely-ranked
  // result set was emptied by a threshold and 'ok' is correct; `partial` means only that SOME
  // content was withheld (`withheld.length > 0` for retrievalUnavailable), which is equally true
  // of a withholding whose remainder really was searched. Only "not one passage was compared"
  // separates those, and only a count can express it.
  if (search.scan?.filesScoped > 0 && comparedNoPassages(search)) return 'not_indexed';
  return null;
}

/**
 * Nothing to report: dependency missing, no accessible corpus, or the arm threw. `retrievalOutcome`
 * is null on all of them - no search completed, so none of them proves anything about whether the
 * corpus is searchable. The throw is the one that does carry a verdict and it records its own
 * 'failed' before returning this; the rest deliberately leave the write to the keyword arm, which
 * really does run and complete on those paths.
 */
const NO_SEMANTIC_RESULT: SemanticArmResult = {
  output: null,
  skipNotice: null,
  datalakeTags: [],
  fileHits: [],
  lakeIds: [],
  chunkIds: [],
  scores: [],
  retrievalOutcome: null,
};

/**
 * Semantic-first KB search: embed the query and cosine-rank against the pre-computed chunk
 * vectors (tag-independent, ranks by meaning), returning the matching passage TEXT inline so
 * the model answers without a search->retrieve-N loop. Returns null to fall through to the
 * keyword path when embedding deps are unavailable or nothing matches.
 *
 * UNSCOPED arm only - resolves owner-wide data-lake access. The agent-scoped arm is
 * tryScopedSemanticKbSearch below, which never consults getDynamicDataLakeAccess.
 */
async function trySemanticKbSearch(
  context: ToolContext,
  query: string,
  tags: string[] | undefined,
  bounds: KbPassageBounds,
  budgets: ResolvedSearchBudgets
): Promise<SemanticArmResult> {
  const chunkRepo = context.db.fabfilechunks;
  if (!context.db.fabfiles || !chunkRepo?.findVectorsByFabFileIds) {
    context.logger.warn('📚 [semantic] falling back to keyword search: fabfiles/fabfilechunks not wired');
    return NO_SEMANTIC_RESULT; // semantic deps not wired - use keyword
  }
  try {
    const embedCtx = await resolveEmbeddingContext(context);
    if (!embedCtx) return NO_SEMANTIC_RESULT;
    const { embeddingModel, provider, apiKeyTable, vectorSearchEnabled } = embedCtx;

    // Narrowed to the session's own lake(s) before anything is searched: without this, a session
    // created FOR one lake still ranks passages from every lake its owner can reach. Subtractive
    // only - see narrowLakeAccessToSession.
    // A personal-corpus session searches with NO lake arms: `collectScopedFiles` passes
    // `includeShared: true` alongside these, so emptying them leaves the caller's own and shared
    // files as the corpus - which is exactly the intent, and keeps their whole library rankable.
    const { dataLakeTags, dataLakeTagPrefixes, lakes } = await resolveSessionLakeAccess(context);
    // No accessible data lake - keyword search owns the user's own files. EXCEPT when the lakes
    // were suppressed deliberately: there the caller does have a corpus worth ranking (their own
    // files), and falling through to the metadata-only keyword arm would lose content search over
    // it entirely. Left intact for the genuinely lake-less caller so their behaviour is unchanged.
    if (dataLakeTags.length === 0 && !context.suppressLakeArms) return NO_SEMANTIC_RESULT;

    const ceiling = resolvePassageCeiling(bounds.rawMaxResults, bounds.defaultResults, budgets.kbResultTokenBudget);
    // Widen the candidate pool when either adaptive knob is on: minScore is re-applied CLIENT-side
    // after the ANN query's own limit-bounded result (see annVectorSearch.ts), so a threshold can
    // leave far fewer survivors than `ceiling`, and the token-budget walk needs candidates to
    // accumulate over. With both knobs off this is Math.max(ceiling, 0, 6) - identical to before.
    const adaptive = budgets.kbResultTokenBudget > 0 || budgets.kbMinRelevance > 0;
    const topK = Math.max(ceiling, adaptive ? KB_SEARCH_MAX_RESULTS : 0, KB_SEARCH_CANDIDATE_FLOOR);

    const lakeMemberships = lakeMembershipsFrom(lakes);
    warnIfManyLakeMemberships(lakeMemberships, context.logger, 'search_knowledge_base:semantic');
    const search = await semanticDataLakeSearch(
      {
        userId: context.userId,
        userGroups: context.user.groups ?? [],
        query,
        tags,
        topK,
        minScore: budgets.kbMinRelevance,
        embeddingModel,
        apiKeyTable,
        dataLakeTags,
        dataLakeTagPrefixes,
        lakeMemberships,
        // Without this the arm below returns empty for a suppressed session and the turn silently
        // falls to metadata-only keyword search - see ownFilesOnly.
        ownFilesOnly: context.suppressLakeArms === true,
        budgets,
        vectorSearchEnabled,
        // Retrieval exclusion (opt-in) - agree with the surface's listing predicate. No-op when unset.
        retrievalFilter: context.retrievalFilter,
        logger: context.logger,
      },
      {
        db: { fabfiles: context.db.fabfiles, fabfilechunks: chunkRepo },
        vectorIndex: selfHostOpenSearchEnabled() ? openSearchChunkAdapter : undefined,
      }
    );

    // Real callers always set alternateModelsEmbedded; the fallback only guards a test
    // double built from a partial result object.
    await recordAllEmbeddingUsage(context, query, embeddingModel, provider, search.alternateModelsEmbedded ?? []);

    // No hits: the keyword arm answers next, but it returns metadata only - `formatSkipNotice`
    // (called on that fallback path) is the ONLY channel that still reaches the model, so a
    // relevance floor that emptied an otherwise-thin-but-nonempty result set has to fold into
    // `skipNotice` here, not just a server log, or the model reads a bare metadata listing as
    // "the knowledge base has nothing on this topic".
    const floorEmptiedResults = budgets.kbMinRelevance > 0 && search.results.length === 0;
    const skipNotice =
      describeSearchLimitations(search) ??
      (floorEmptiedResults
        ? 'a configured relevance threshold filtered out every candidate passage for this query'
        : null);
    if (search.results.length === 0) {
      if (floorEmptiedResults) {
        context.logger.log(
          `📚 [semantic] 0 results at relevance floor ${budgets.kbMinRelevance.toFixed(2)} (candidates existed above 0 but none cleared the floor)`
        );
      }
      return {
        output: null,
        skipNotice,
        datalakeTags: [],
        fileHits: [],
        lakeIds: [],
        chunkIds: [],
        scores: [],
        retrievalOutcome: proveRetrievalOutcome(search),
      };
    }

    // Bound by token budget (the primary lever once configured), with the passage ceiling as a
    // safety rail - replaces the old flat `.slice(0, maxResults)`. Ordering matters: this MUST run
    // before emitSemanticCitables and before fileHits/lakeIds/chunkIds below, or the audit trail and
    // the model's citations would include passages the model never actually saw.
    const bound = await boundPassagesByTokenBudget(search.results, {
      tokenBudget: budgets.kbResultTokenBudget,
      maxPassages: ceiling,
      // Non-widened fallback on pricing failure - see boundPassagesByTokenBudget's own doc comment.
      fallbackCount: clampMaxResults(bounds.rawMaxResults, bounds.defaultResults),
      maxChunkChars: budgets.maxChunkChars,
      tokenizer: getSharedTokenizer(context.logger),
      logger: context.logger,
    });
    const ranked = bound.kept;

    await emitSemanticCitables(context, ranked, 'the data lake', skipNotice, dataLakeTags);
    context.logger.log(
      `📚 [semantic] returning ${ranked.length}/${search.results.length} passages from ${new Set(ranked.map(r => r.fileId)).size} files (top score ${search.results[0].score.toFixed(3)}${budgets.kbResultTokenBudget > 0 ? `, ${bound.tokensUsed} tokens` : ''}${bound.budgetBound ? ', budget-bound' : ''})`
    );

    // Provenance for retrieval-scoped lake-prompt injection: which lakes these passages came from.
    return {
      output: formatSemanticResults(ranked, budgets.maxChunkChars, search.scan, skipNotice, context.logger, {
        budgetBound: bound.budgetBound,
        // Against `ceiling`, not the full retrieved set: `search.results` can hold up to
        // KB_SEARCH_MAX_RESULTS candidates once the budget widens topK, but everything past
        // `ceiling` was never admissible in the first place (a model-supplied max_results
        // narrows it below the widened topK) - attributing those to "the budget withheld them"
        // overstates what the budget actually did.
        droppedCount: Math.min(search.results.length, ceiling) - ranked.length,
      }),
      skipNotice,
      datalakeTags: datalakeTagsFrom(ranked.flatMap(r => r.fileTags)),
      fileHits: ranked.map(r => ({ id: r.fileId, fileName: r.fileName })),
      // semanticDataLakeSearch's file search is a MIXED corpus (includeShared: true, no
      // restrictToDataLake - collectScopedFiles ORs the caller's own/shared files in alongside
      // the lake arms), same as the keyword arm below - a hit with no recoverable tag may be the
      // caller's own private file, so this must NOT fall back to the full scope.
      lakeIds: attributeAccessedLakeIds(
        ranked.map(r => r.fileTags),
        lakes,
        { allowFullScopeFallback: false }
      ),
      chunkIds: ranked.map(r => r.chunkId),
      scores: ranked.map(r => r.score),
      // Passages were returned, so emitSemanticCitables above already recorded the 'ok' this
      // arm proved; there is nothing left for the keyword arm to stamp.
      retrievalOutcome: null,
    };
  } catch (err) {
    context.logger.warn('📚 [semantic] KB search failed, falling back to keyword:', err);
    // A genuine failure must not fabricate a notice. It also must not go unrecorded: the
    // keyword arm below runs next and, on a hit, would otherwise be the only write this turn,
    // stamping outcome:'ok' over a search that actually threw. Recording 'failed' here relies on
    // mergeRetrievalSummary's worst-of-severity merge (failed always outranks ok) to survive that
    // later write (#1867 review).
    await context.statusUpdate({
      promptMeta: {
        retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
      },
    } as any);
    return NO_SEMANTIC_RESULT;
  }
}

/**
 * Agent-scoped semantic arm: cosine-rank ONLY the kbScope file set. Contains no reference
 * to getDynamicDataLakeAccess by construction - scope membership is the sole authority, so
 * owner-wide data-lake resolution is unreachable from here. Returns null to fall through to
 * the (also scoped) keyword path.
 */
async function tryScopedSemanticKbSearch(
  context: ToolContext,
  scopeFileIds: string[],
  query: string,
  bounds: KbPassageBounds,
  budgets: ResolvedSearchBudgets
): Promise<SemanticArmResult> {
  const chunkRepo = context.db.fabfilechunks;
  if (!context.db.fabfiles || !chunkRepo?.findVectorsByFabFileIds) {
    context.logger.warn('📚 [semantic] falling back to keyword search: fabfiles/fabfilechunks not wired');
    return NO_SEMANTIC_RESULT;
  }
  try {
    const embedCtx = await resolveEmbeddingContext(context);
    if (!embedCtx) return NO_SEMANTIC_RESULT;
    const { embeddingModel, provider, apiKeyTable, vectorSearchEnabled } = embedCtx;

    const ceiling = resolvePassageCeiling(bounds.rawMaxResults, bounds.defaultResults, budgets.kbResultTokenBudget);
    const adaptive = budgets.kbResultTokenBudget > 0 || budgets.kbMinRelevance > 0;
    const topK = Math.max(ceiling, adaptive ? KB_SEARCH_MAX_RESULTS : 0, KB_SEARCH_CANDIDATE_FLOOR);

    const search = await fileScopedSemanticSearch(
      {
        query,
        fileIds: scopeFileIds,
        topK,
        minScore: budgets.kbMinRelevance,
        embeddingModel,
        apiKeyTable,
        budgets,
        vectorSearchEnabled,
        logger: context.logger,
      },
      {
        db: { fabfiles: context.db.fabfiles, fabfilechunks: chunkRepo },
        vectorIndex: selfHostOpenSearchEnabled() ? openSearchChunkAdapter : undefined,
      }
    );

    // Real callers always set alternateModelsEmbedded; the fallback only guards a test
    // double built from a partial result object.
    await recordAllEmbeddingUsage(context, query, embeddingModel, provider, search.alternateModelsEmbedded ?? []);

    // See the matching branch in trySemanticKbSearch above for why this folds into skipNotice.
    const scopedFloorEmptiedResults = budgets.kbMinRelevance > 0 && search.results.length === 0;
    const skipNotice =
      describeSearchLimitations(search) ??
      (scopedFloorEmptiedResults
        ? 'a configured relevance threshold filtered out every candidate passage for this query'
        : null);
    if (search.results.length === 0) {
      if (scopedFloorEmptiedResults) {
        context.logger.log(
          `📚 [semantic] 0 scoped results at relevance floor ${budgets.kbMinRelevance.toFixed(2)} (candidates existed above 0 but none cleared the floor)`
        );
      }
      return {
        output: null,
        skipNotice,
        datalakeTags: [],
        fileHits: [],
        lakeIds: [],
        chunkIds: [],
        scores: [],
        retrievalOutcome: proveRetrievalOutcome(search),
      };
    }

    const bound = await boundPassagesByTokenBudget(search.results, {
      tokenBudget: budgets.kbResultTokenBudget,
      maxPassages: ceiling,
      // Non-widened fallback on pricing failure - see boundPassagesByTokenBudget's own doc comment.
      fallbackCount: clampMaxResults(bounds.rawMaxResults, bounds.defaultResults),
      maxChunkChars: budgets.maxChunkChars,
      tokenizer: getSharedTokenizer(context.logger),
      logger: context.logger,
    });
    const ranked = bound.kept;
    await emitSemanticCitables(context, ranked, "this agent's knowledge base", skipNotice, []);
    // Agent-scoped results never carry a lake prompt: this arm must not consult owner-wide access
    // or imply a wider corpus, so its provenance is intentionally empty (no injection downstream).
    return {
      output: formatSemanticResults(ranked, budgets.maxChunkChars, search.scan, skipNotice, context.logger, {
        budgetBound: bound.budgetBound,
        // Against `ceiling`, not the full retrieved set: `search.results` can hold up to
        // KB_SEARCH_MAX_RESULTS candidates once the budget widens topK, but everything past
        // `ceiling` was never admissible in the first place (a model-supplied max_results
        // narrows it below the widened topK) - attributing those to "the budget withheld them"
        // overstates what the budget actually did.
        droppedCount: Math.min(search.results.length, ceiling) - ranked.length,
      }),
      skipNotice,
      datalakeTags: [],
      fileHits: ranked.map(r => ({ id: r.fileId, fileName: r.fileName })),
      lakeIds: [],
      chunkIds: ranked.map(r => r.chunkId),
      scores: ranked.map(r => r.score),
      // See the matching return in trySemanticKbSearch: the 'ok' is already recorded.
      retrievalOutcome: null,
    };
  } catch (err) {
    context.logger.warn('📚 [semantic] scoped KB search failed, falling back to scoped keyword:', err);
    // See the matching catch in trySemanticKbSearch above: relies on mergeRetrievalSummary's
    // worst-of-severity merge to survive the scoped keyword arm's later 'ok' write.
    await context.statusUpdate({
      promptMeta: {
        retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
      },
    } as any);
    return NO_SEMANTIC_RESULT;
  }
}

/**
 * Ceiling on `max_results`. The tool schema below and the clamp in the handler BOTH read this,
 * so the number advertised to the model and the number enforced on it cannot drift apart - the
 * same reason the serve budget is derived from the chunk policy rather than set beside it.
 *
 * Stays a coded constant rather than the `kbSearchDefaultResults` setting's sibling lever: it is
 * also the tool schema's advertised `maximum`, and that schema is built synchronously (see
 * `knowledgeBaseSearchTool.implementation` below), so raising it here alone would be inert - a
 * model reading `maximum: 10` from its own tool schema won't ask for more than 10 regardless.
 */
export const KB_SEARCH_MAX_RESULTS = 10;

/**
 * Passage-count floor `clampMaxResults` never goes below, once a search actually found something.
 * Distinct from `boundByTokenBudget`'s own "first passage always admitted" rule, which enforces the
 * same floor at the token-budget layer - the two mechanisms need their own copy of this floor
 * because either is reachable without the other: an explicit `max_results` narrows straight through
 * `clampMaxResults` and never reaches the token walk at all. No external consumer; not exported.
 */
const KB_SEARCH_MIN_RESULTS = 1;

/**
 * Candidate-pool floor for the ranker (was an unnamed inline `6` at both semantic call sites):
 * cosine ranking needs a wider pool than the passage count being requested, or a 1-result request
 * would rank against a pool of exactly 1.
 */
const KB_SEARCH_CANDIDATE_FLOOR = 6;

/**
 * All of `search_knowledge_base`'s operator-tunable budgets, resolved once per completion (see the
 * `budgetsPromise` cache below) on the CALLER's org/owner scope (#1955 item 4) - a knowledge-base
 * search spans a mixed multi-lake corpus plus the caller's own/shared files, so there is no single
 * lake for a narrower rung to key on (see `scopeForCaller`'s own doc comment).
 */
async function resolveKbBudgets(context: ToolContext): Promise<ResolvedSearchBudgets> {
  return resolveSearchBudgets(
    { adminSettings: context.db.adminSettings, scopedSettings: context.db.scopedSettings },
    context.logger,
    scopeForCaller({ userId: context.userId, organizationId: context.user.organizationId })
  );
}

/**
 * Narrow a model-supplied `max_results` to the bound the schema advertises.
 *
 * The schema's `minimum`/`maximum` are advisory: nothing in the chat path's tool dispatch
 * validates params, so whatever the model emits arrives here as-is and must be made safe at the
 * handler (the shape knowledgeBaseRetrieve, bashExecute and wolfram_alpha already use). The CLI's
 * tool_search takes the other route for the same problem - see ToolSearchParamsSchema in
 * packages/cli/src/tools/toolSearchTool.ts, which safeParses and REJECTS out-of-range rather than
 * clamping; that stays out of the chat path, where a rejected search costs the turn. Both ends are clamped
 * because every out-of-range value fails SILENTLY otherwise: 0 serves no passages while telling
 * the model nothing, a negative slices off the best-ranked results, and a non-numeric poisons
 * topK as NaN. Typed `unknown` because the declared `number` is only a claim about JSON we parsed.
 *
 * Unset takes `defaultResults` rather than the floor, matching positiveIntOr in
 * resolveSearchBudgets: `null` and `''` are the model declining to choose, not a request for one
 * result. `defaultResults` is the caller's already-resolved `kbSearchDefaultResults` value, not
 * re-read here, so this stays synchronous. It is still run through the same clamp below: the
 * setting's own schema already rejects a stored value above KB_SEARCH_MAX_RESULTS, but clamping
 * here too keeps that ceiling a guarantee of this function, not a fact borrowed from a different
 * package's validation.
 */
function clampMaxResults(raw: unknown, defaultResults: number): number {
  const safeDefault = Math.min(Math.max(defaultResults, KB_SEARCH_MIN_RESULTS), KB_SEARCH_MAX_RESULTS);
  if (raw === undefined || raw === null || raw === '') return safeDefault;
  const n = Number(raw);
  if (!Number.isFinite(n)) return safeDefault;
  return Math.min(Math.max(Math.floor(n), KB_SEARCH_MIN_RESULTS), KB_SEARCH_MAX_RESULTS);
}

/** What each semantic arm needs to derive its own passage-count safety rail (#1955 item 3). */
interface KbPassageBounds {
  /**
   * Unvalidated model-supplied `max_results`, straight from `params`. Every consumer
   * (`resolvePassageCeiling`, and the `fallbackCount` clamp at both `boundPassagesByTokenBudget`
   * call sites) clamps it via `clampMaxResults`/`resolvePassageCeiling` before use - there is no
   * single choke point enforcing this anymore, so a new consumer must remember to clamp too.
   */
  rawMaxResults: unknown;
  defaultResults: number;
}

/**
 * The passage-count SAFETY RAIL for one semantic search - no longer the primary bound (#1955 item
 * 3). `clampMaxResults` keeps its own contract ("narrow a model-supplied param") unchanged; this
 * layers the budget-aware decision on top of it:
 *  - the model explicitly asked for a count: that still narrows the result, via `clampMaxResults`.
 *  - it did not, and no token budget is configured: the resolved default IS the bound, byte-for-
 *    byte identical to pre-#1955 behavior.
 *  - it did not, and a token budget IS configured: the rail opens to `KB_SEARCH_MAX_RESULTS` so
 *    breadth can adapt to chunk size instead of being pinned to a fixed count.
 */
function resolvePassageCeiling(raw: unknown, defaultResults: number, tokenBudget: number): number {
  const modelChose = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw));
  if (modelChose) return clampMaxResults(raw, defaultResults);
  if (tokenBudget > 0) return KB_SEARCH_MAX_RESULTS;
  return clampMaxResults(raw, defaultResults);
}

interface KnowledgeBaseSearchParams {
  query: string;
  tags?: string[];
  file_type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
  max_results?: number;
}

/**
 * Formats fab file search results for LLM consumption.
 *
 * Metadata only (the caller passes excludeContent), but every field here is still authored
 * document-side, so the same defenses apply as to retrieved content: a file name carrying a
 * newline would otherwise land arbitrary text at column 0 in the model's context with no framing
 * at all - which is worse than the delimited case, not better. No untrusted block wraps this: it
 * returns no document text, and the block would say "this is data" about our own listing.
 */
function formatSearchResults(files: IFabFileDocument[]): string {
  if (files.length === 0) {
    return 'No documents found matching your search query in your knowledge base.';
  }

  const formattedFiles = files.map((file, index) => {
    const tags = toContentLabel(file.tags?.map(t => t.name).join(', ') || 'none');
    const notes = file.notes ? `\n   Notes: ${defangRetrievedContent(file.notes)}` : '';
    const fileType = file.type || 'FILE';
    // Machine state, not owner text, so it stays out of the defanged half: without it a
    // zero-chunk or paused file lists clean and the model reports it as readable.
    const stall = describePipelineStall(file);
    const pipeline = stall ? `\n   Pipeline: ${stall}` : '';

    return (
      `${index + 1}. **${toContentLabel(file.fileName)}** (ID: ${file.id})\n` +
      `   Type: ${fileType} | MIME: ${file.mimeType}\n` +
      `   Tags: ${tags}${pipeline}${notes}`
    );
  });

  return (
    `Found ${files.length} document(s) in your knowledge base:\n\n` +
    formattedFiles.join('\n\n') +
    '\n\n*Use retrieve_knowledge_content with a file ID or tags to read the actual document content.*'
  );
}

/**
 * Extra note when the session has an attachment still chunking, so the model does not read a
 * zero/near-zero result as "this file is inaccessible" when its raw content is already inlined
 * elsewhere in the prompt (see ToolContext.inlinedAttachmentIds). Two shapes:
 *  - zero hits at all: the attachment may not be findable by search yet, but is already above.
 *  - a hit IS an inlined attachment: heads off a follow-up retrieve_knowledge_content call that
 *    would just return the same "not indexed yet" result for content the model already has -
 *    but only when the WHOLE file is above (ToolContext.fullyInlinedAttachmentIds). A file that
 *    is merely inlined can still be a cosine excerpt or a truncated head (#1163 review), so
 *    telling the model it never needs retrieval for that file would suppress the one path that
 *    can fetch the rest of it.
 * Returns '' when there is nothing to add, so an unpopulated context (agent/embed surfaces) is a
 * byte-identical no-op.
 */
function attachmentInlineNotice(context: ToolContext, rankedResults: Array<{ id: string; fileName: string }>): string {
  const inlined = context.inlinedAttachmentIds;
  if (!inlined?.length) return '';
  const fullyInlined = new Set(context.fullyInlinedAttachmentIds ?? []);

  if (rankedResults.length === 0) {
    // Hedged ("may") rather than asserted: deferral to retrieval is the exception
    // (resolveCorpusInlinePlan, lake access + a large corpus), so most inlined attachments here
    // are ordinary, fully-searchable files where a zero-hit result just means the query missed -
    // not that the file is unsearchable. Matches the sibling wording in knowledgeBaseRetrieve.
    const fullyInlinedIds = inlined.filter(id => fullyInlined.has(id));
    const partialIds = inlined.filter(id => !fullyInlined.has(id));
    const parts: string[] = [];
    if (fullyInlinedIds.length > 0) {
      parts.push(
        `${fullyInlinedIds.length} file(s) attached to this conversation may not be indexed for search yet, ` +
          `so they may not be found through this tool. Their content was already included directly in the ` +
          `conversation above - answer from that rather than telling the user the attachment is inaccessible.`
      );
    }
    if (partialIds.length > 0) {
      parts.push(
        `${partialIds.length} file(s) attached to this conversation may not be indexed for search yet, so ` +
          `they may not be found through this tool. PART of their content was already included directly in ` +
          `the conversation above, but what is shown may be an excerpt or a truncated head - answer from ` +
          `that if it covers the question, but do not assume it is the whole document.`
      );
    }
    return `\n\nNOTE: ${parts.join(' ')}`;
  }

  // Deduped by id: the semantic arm's rankedResults is per-PASSAGE, so a top-K result can carry
  // several chunks from the same inlined file and would otherwise repeat its name in the notice.
  const inlinedHits = Array.from(
    new Map(rankedResults.filter(f => inlined.includes(f.id)).map(f => [f.id, f])).values()
  );
  if (inlinedHits.length === 0) return '';

  const fullHits = inlinedHits.filter(f => fullyInlined.has(f.id));
  const partialHits = inlinedHits.filter(f => !fullyInlined.has(f.id));
  const parts: string[] = [];
  if (fullHits.length > 0) {
    const names = fullHits.map(f => `"${f.fileName}"`).join(', ');
    parts.push(
      `${names} are attached to this conversation and their content is already included above - ` +
        `you do not need retrieve_knowledge_content for them (it may return nothing while indexing ` +
        `is still in progress).`
    );
  }
  if (partialHits.length > 0) {
    const names = partialHits.map(f => `"${f.fileName}"`).join(', ');
    parts.push(
      `${names} are attached to this conversation and part of their content is already included ` +
        `above, but what is shown may be an excerpt or a truncated head - retrieve_knowledge_content ` +
        `may still surface additional passages from them.`
    );
  }
  return `\n\nNOTE: ${parts.join(' ')}`;
}

export const knowledgeBaseSearchTool: ToolDefinition = {
  name: 'search_knowledge_base',
  implementation: context => {
    // Per-completion call counter - this closure is created ONCE per completion, so it
    // persists across every search_knowledge_base call in that turn. Eager models (esp.
    // Sonnet) re-search the same topic many times; once a few good searches have returned
    // the relevant passages, we hard-stop the loop and tell the model to compose its answer.
    let searchCallCount = 0;
    const MAX_SEARCHES = 3;
    // Per-completion set of `datalake:` tags whose lake prompt has already been injected this turn,
    // so multiple search_knowledge_base calls never restate the same lake's instructions (#1108).
    const injectedLakeTags = new Set<string>();
    // Carries the most recent skip notice across calls in this completion, so the model still
    // hears about a comparability gap on the capped call, which never runs a search of its own.
    let lastSkipNotice: string | null = null;
    // Resolved at most once per completion, same discipline as searchCallCount above - a settings
    // (+ scoped-overlay) read on every search_knowledge_base call would cost a real DB round-trip
    // for no benefit, since every call in a completion shares the same caller scope. Resolved only
    // past the cap check below, so a capped call (which never searches) never pays for it either.
    let budgetsPromise: Promise<ResolvedSearchBudgets> | undefined;
    return {
      toolFn: async value => {
        const params = value as KnowledgeBaseSearchParams;
        await context.onStart?.('search_knowledge_base', params);
        const { query, tags, file_type } = params;

        searchCallCount++;
        if (searchCallCount > MAX_SEARCHES) {
          context.logger.log(
            `📚 Knowledge Base Search: call #${searchCallCount} — capped, instructing model to answer`
          );
          // No attachmentInlineNotice here: by this point real searches have already run and may
          // have found hits, so a hardcoded empty-results notice would wrongly claim attachments
          // "are not indexed for search yet" and cast doubt on passages already surfaced above.
          return (
            `You have already run ${searchCallCount - 1} knowledge-base searches; the relevant passages are in the conversation above. ` +
            `STOP searching and compose your complete answer NOW from those results. Do NOT call search_knowledge_base ` +
            `or retrieve_knowledge_content again unless a specific named fact is genuinely missing.` +
            formatSkipNotice(lastSkipNotice)
          );
        }

        budgetsPromise ??= resolveKbBudgets(context);
        const budgets = await budgetsPromise;
        // The semantic arms resolve their own passage ceiling (resolvePassageCeiling) once they
        // know whether a token budget is configured; the keyword arm below has no token budget to
        // adapt to (metadata-only), so it clamps directly to the resolved default, same as before.
        const bounds: KbPassageBounds = { rawMaxResults: params.max_results, defaultResults: budgets.kbDefaultResults };
        const maxResults = clampMaxResults(params.max_results, budgets.kbDefaultResults);

        context.logger.log('📚 Knowledge Base Search: userId:', context.userId, 'query:', query, 'tags:', tags);

        if (!context.db.fabfiles) {
          context.logger.error('❌ Knowledge Base Search: fabfiles repository not available');
          // Both the semantic and keyword arms below depend on context.db.fabfiles - with it
          // absent, nothing can be searched, so this is a genuine failure, not an abstain.
          await context.statusUpdate({
            promptMeta: {
              retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
            },
          } as any);
          return 'Knowledge base search is not available at this time.';
        }

        // Agent-scoped KB restriction (see KbScope). An empty scope reads NOTHING - return
        // the generic no-results message before either arm runs, never fall back owner-wide.
        // Agent restriction only. A personal-corpus session is NOT expressed here - see
        // ToolContext.suppressLakeArms for why narrowing to the attachments was the wrong shape.
        const scope = context.kbScope;
        if (scope && scope.fileIds.length === 0) {
          // Deliberately untouched even if inlinedAttachmentIds were ever set here: an
          // empty-scope agent surface must read as a pure "nothing in scope" early return, not
          // acquire new behavior tied to a signal this surface was never designed to receive.
          await context.statusUpdate({
            promptMeta: {
              retrieval: { attempted: true, outcome: 'no_lakes', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
            },
          } as any);
          return formatSearchResults([]);
        }

        // Semantic-first: rank by meaning and return passage CONTENT inline so the model can
        // answer without a search->retrieve loop. Falls through to keyword search below if the
        // embedding deps aren't wired or nothing matches. The scoped arm never consults
        // owner-wide data-lake access.
        const semantic = scope
          ? await tryScopedSemanticKbSearch(context, scope.fileIds, query, bounds, budgets)
          : await trySemanticKbSearch(context, query, tags, bounds, budgets);
        lastSkipNotice = semantic.skipNotice;
        // Attach the retrieved lakes' scoped prompts (no-op for the agent-scoped arm, whose
        // datalakeTags are empty). The keyword fallback below returns metadata only (no grounded
        // content), so a lake prompt rides only actual retrieved content; the keyword path's content
        // enters later via retrieve_knowledge_content, which injects there. Test .output, not the
        // object: the arm always resolves to a truthy result now, so `if (semantic)` would swallow
        // the keyword fallback entirely.
        if (semantic.output) {
          const withLakePrompts = await prependRetrievedLakePrompts(
            context,
            semantic.output,
            semantic.datalakeTags,
            injectedLakeTags
          );
          // Best-effort audit write, only reached when semantic.output is non-null - a null output
          // means the search was skipped or found nothing, so there is no lake read to record.
          // resolvedLakeIds stays empty for the agent-scoped arm by design (semantic.lakeIds is
          // always [] there) - it never consults lake access, and it is recorded regardless
          // (membership IS the authorization). The unscoped arm's corpus is mixed, so it is
          // skipped entirely when nothing retrieved is actually attributable to a lake.
          if (scope || semantic.lakeIds.length > 0) {
            recordLakeAccessEvent(
              context.db.lakeAccessEvents,
              {
                // Always 'user', including an agent-executor run - see ToolContext.userId's doc comment.
                principalKind: 'user',
                principalId: context.userId,
                organizationId: normalizeId(context.user.organizationId),
                resolvedLakeIds: semantic.lakeIds,
                // semantic.fileHits is chunk-level (one entry per ranked passage, per fileHits'
                // own construction below) - deduped the same way semantic-search.ts's sibling
                // route does, so this counts files read, not chunks matched.
                fileIds: [...new Set(semantic.fileHits.map(f => f.id))],
                chunkIds: semantic.chunkIds,
                scores: semantic.scores,
                surface: scope ? 'chat-kb-search-scoped' : 'chat-kb-search',
                queryText: query,
                questId: context.questId,
                sessionId: context.sessionId,
              },
              context.logger,
              context.db.adminSettings
            );
          }
          return withLakePrompts + attachmentInlineNotice(context, semantic.fileHits);
        }

        try {
          let searchResults;
          // Populated only in the unscoped arm below (mirrors the semantic arm: a scoped call
          // never consults lake access, so its audit event carries no lake attribution either).
          let keywordArmLakes: AttributableLake[] = [];
          if (scope) {
            // Scoped keyword arm: restrictToFileIds is the sole authority (skipOwnership -
            // curated files match even when owned by another user, mirroring the semantic
            // arm's getAccessibleFiles). No owner/shared/org expansion, no data-lake
            // resolution (getDynamicDataLakeAccess is not called on this branch).
            searchResults = await context.db.fabfiles.search(
              context.userId,
              query,
              {
                tags: tags || [],
                type: file_type,
                shared: false,
                restrictToFileIds: scope.fileIds,
              },
              { page: 1, limit: 200 },
              { by: 'fileName', direction: 'asc' },
              {
                textSearch: true,
                includeShared: false,
                userGroups: [],
                skipOwnership: true,
                excludeContent: true,
                ...(context.retrievalFilter ?? {}),
              }
            );
          } else {
            // Search files the user has access to (owned + shared + org-shared + data lake)
            // Same treatment as the semantic arm above - a fallback that re-widened to owner-wide
            // lake access would undo the scope on exactly the turns semantic search found nothing.
            const { dataLakeTags, dataLakeTagPrefixes, lakes } = await resolveSessionLakeAccess(context);
            keywordArmLakes = lakes;
            const lakeMemberships = lakeMembershipsFrom(lakes);
            warnIfManyLakeMemberships(lakeMemberships, context.logger, 'search_knowledge_base:keyword-fallback');
            searchResults = await context.db.fabfiles.search(
              context.userId,
              query,
              {
                tags: tags || [],
                type: file_type,
                shared: false, // Not filtering to ONLY shared files
              },
              {
                page: 1,
                // The WIDE candidate pool only matters for data-lake searches: that corpus is large
                // and the underlying search sorts by fileName ASC, so a small page alphabetically
                // truncates matches ([Products] sits past [Acquisitions]/[Cloud] and never entered a
                // 50-row page, burying the right docs). For a user's own/shared files (small corpus,
                // no data-lake access) the wide fetch is an unnecessary regression - use a small cap.
                // (Proper fix for the lake: semantic search above; this is the keyword fallback.)
                limit: dataLakeTags.length > 0 ? 200 : 50,
              },
              {
                by: 'fileName',
                direction: 'asc',
              },
              {
                textSearch: true, // Search across fileName + tags + notes for better recall
                includeShared: true, // Include owned + explicitly shared + org-shared files
                userGroups: context.user.groups || [], // Pass user's groups for org-level sharing
                dataLakeTags,
                dataLakeTagPrefixes, // Static-registry (open) prefixes — match shared KB files
                lakeMemberships, // Dynamic-lake arms, each anchored to that lake's creator
                excludeContent: true, // Search only needs metadata — content fetched via retrieve tool
                // Retrieval exclusion (opt-in) - best-effort DB pre-filter; authoritative pass below. No-op when unset.
                ...(context.retrievalFilter ?? {}),
              }
            );
          }

          // Dedup (the lake can contain duplicate uploads) and relevance-rank by how well each
          // file's metadata matches the query - since the underlying search sorts by fileName
          // ASC, the most relevant files would otherwise be buried. Metadata-only proxy ranking:
          // this is the KEYWORD fallback, reached only when the semantic arms above are
          // unavailable or found nothing, so embedding ranking is not an option here.
          const queryTerms = Array.from(
            new Set(
              query
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter(t => t.length >= 3)
            )
          );
          const scoreFile = (file: IFabFileDocument): number => {
            const hay = `${file.fileName} ${(file.tags?.map(t => t.name) || []).join(' ')} ${
              file.notes || ''
            }`.toLowerCase();
            return queryTerms.reduce((n, term) => (hay.includes(term) ? n + 1 : n), 0);
          };
          const seen = new Set<string>();
          // Authoritative exclusion pass on top of the DB pre-filter (see filterRetrievalExcluded).
          const rankedResults = filterRetrievalExcluded(searchResults.data, context.retrievalFilter ?? {})
            .filter((f: IFabFileDocument) => {
              // Dedup by fileName, not id: the lake's duplicates are separate FabFile docs
              // (re-uploads) with the SAME fileName but DIFFERENT ids, so an id-key misses them.
              const key = (f.fileName || f.id || '').toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((f: IFabFileDocument) => ({ f, score: scoreFile(f) }))
            .sort((a, b) => b.score - a.score || a.f.fileName.localeCompare(b.f.fileName))
            .slice(0, maxResults)
            .map(r => r.f);

          context.logger.log(
            '📚 Knowledge Base Search: Found',
            rankedResults.length,
            'of',
            searchResults.total,
            'results (deduped + relevance-ranked). Files:',
            rankedResults.map((f: IFabFileDocument) => f.fileName)
          );

          // Whatever the semantic arm proved about the corpus outranks this arm's own verdict, on
          // BOTH branches below. That is not the same claim as "the tool found nothing": this arm
          // matches on file METADATA, so it can list documents whose text was never compared to
          // the query, and calling that 'ok' says the library was searched when only its filenames
          // were. The two branches differ in whether anything was FOUND, not in whether anything
          // was SEARCHED, so a verdict that turns on the latter has to apply to both or the same
          // field would mean different things two branches apart.
          //
          // 'ok' when the arm proved nothing, which is the same claim this write has always made:
          // the semantic arm ran to completion (or never ran at all - see NO_SEMANTIC_RESULT) and
          // this keyword pass then completed too, so retrieval happened and must stay
          // distinguishable from "never searched" (#1867).
          const keywordArmOutcome = semantic.retrievalOutcome ?? 'ok';

          // Emit citable source chips so search results appear as clickable citations
          if (rankedResults.length > 0) {
            const citables: CitableSource[] = rankedResults.map((file: IFabFileDocument, index: number) => {
              const fileTags = (file.tags?.map(t => t.name) || [])
                .filter(t => !t.startsWith('datalake:'))
                .slice(0, 4)
                .join(', ');
              return {
                id: file.id,
                type: 'document' as const,
                title: file.fileName,
                url: `/opti?mode=datalake&article=${file.id}`,
                description: fileTags || undefined,
                timestamp: new Date().toISOString(),
                status: 'complete' as const,
                metadata: {
                  sourceSystem: 'knowledge_base',
                  tags: file.tags?.map(t => t.name) || [],
                  relevanceScore: 1 - index * 0.1,
                },
              };
            });

            // Surface what we FOUND in the live status (not just "searching") so the user
            // watches the agent work the data lake. Clean up the raw "[Category] 01 Name.md"
            // filenames into readable titles for the status line.
            const prettyName = (fn: string) =>
              fn
                .replace(/\.[a-z0-9]+$/i, '')
                .replace(/^\[[^\]]*\]\s*/, '')
                .replace(/^\d+[\s._-]*/, '')
                .replace(/[-_]+/g, ' ')
                .trim();
            const names = rankedResults.slice(0, 3).map((f: IFabFileDocument) => prettyName(f.fileName));
            const more = rankedResults.length > 3 ? ` +${rankedResults.length - 3} more` : '';
            // Scoped wording avoids "data lake" framing - a scoped caller sees only the
            // agent's KB, and the status must not imply a wider corpus exists.
            // Three corpora, three names. Saying "this agent's knowledge base" on an ordinary
            // session with no agent is text the model paraphrases straight to the user.
            const corpusLabel = scope
              ? "this agent's knowledge base"
              : context.suppressLakeArms
                ? 'your files'
                : 'the data lake';
            // The semantic arm's notice (e.g. every matching file withheld for a model mismatch)
            // has to land here too: when semantic finds nothing to say, this keyword status is the
            // ONLY user-visible write for the turn, so a total-withholding warning would otherwise
            // never reach the promptMeta inspector or the status line.
            const skipSuffix = semantic.skipNotice ? PARTIAL_RESULTS_STATUS_SUFFIX : '';
            const foundStatus = `📄 Found ${rankedResults.length} in ${corpusLabel}: ${names.join(', ')}${more}${skipSuffix}`;
            await context.statusUpdate(
              {
                promptMeta: {
                  citables,
                  ...(semantic.skipNotice ? { warnings: [semantic.skipNotice] } : {}),
                  retrieval: {
                    attempted: true,
                    outcome: keywordArmOutcome,
                    surfaces: ['knowledgeBaseSearch'],
                    dataLakeTags: keywordArmLakes.map(l => l.datalakeTag),
                  },
                },
              } as any,
              foundStatus
            );
            context.logger.log(`📚 Knowledge Base Search: Stored ${citables.length} citables`);
          } else {
            // No hits - tell the user what was searched so the wait reads as deliberate.
            const clippedQuery = query.length > 50 ? query.slice(0, 49) + '…' : query;
            const skipSuffix = semantic.skipNotice ? PARTIAL_RESULTS_STATUS_SUFFIX : '';
            await context.statusUpdate(
              {
                promptMeta: {
                  ...(semantic.skipNotice ? { warnings: [semantic.skipNotice] } : {}),
                  // Zero hits, so the outcome is the whole signal this write carries - see
                  // `keywordArmOutcome` above for why 'ok' here is a claim about the SEARCH and
                  // not about the empty result.
                  retrieval: {
                    attempted: true,
                    outcome: keywordArmOutcome,
                    surfaces: ['knowledgeBaseSearch'],
                    dataLakeTags: keywordArmLakes.map(l => l.datalakeTag),
                  },
                },
              } as any,
              (scope
                ? `📭 No matches in this agent's knowledge base for "${clippedQuery}"`
                : `📭 No data-lake matches for "${clippedQuery}" - broadening...`) + skipSuffix
            );
          }

          // Best-effort audit write, only when the keyword fallback actually found
          // something - an empty rankedResults means nothing was read. The unscoped arm's
          // corpus is mixed (owned + shared + org-shared + data lake), so a hit with no
          // recoverable datalake tag may just be the caller's own private file - never fall
          // back to the full scope here (unlike the semantic arms, whose corpus is lake-scoped
          // by construction), and skip the row entirely if nothing is actually attributable to a
          // lake, since a read that touched zero lake content is not lake access. The scoped arm
          // has no lake concept at all (resolvedLakeIds is always []) but is recorded regardless -
          // see the surface's own note on why that row still matters.
          if (rankedResults.length > 0) {
            const resolvedLakeIds = attributeAccessedLakeIds(
              rankedResults.map((f: IFabFileDocument) => f.tags?.map(t => t.name) ?? []),
              keywordArmLakes,
              { allowFullScopeFallback: false }
            );
            if (scope || resolvedLakeIds.length > 0) {
              recordLakeAccessEvent(
                context.db.lakeAccessEvents,
                {
                  // Always 'user', including an agent-executor run - see ToolContext.userId's doc comment.
                  principalKind: 'user',
                  principalId: context.userId,
                  organizationId: normalizeId(context.user.organizationId),
                  resolvedLakeIds,
                  fileIds: rankedResults.map((f: IFabFileDocument) => f.id),
                  surface: scope ? 'chat-kb-search-scoped' : 'chat-kb-search',
                  queryText: query,
                  questId: context.questId,
                  sessionId: context.sessionId,
                },
                context.logger,
                context.db.adminSettings
              );
            }
          }

          return (
            formatSearchResults(rankedResults) +
            formatSkipNotice(semantic.skipNotice) +
            attachmentInlineNotice(context, rankedResults)
          );
        } catch (error) {
          context.logger.error('❌ Knowledge Base Search: Error during search:', error);
          // A retrieval that threw must not be byte-identical to one never attempted (#1867).
          // dataLakeTags is empty here - the error can occur before any arm resolves which lakes
          // were in scope, so there is nothing honest to stamp at this outer catch.
          await context.statusUpdate({
            promptMeta: {
              retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
            },
          } as any);
          return 'An error occurred while searching your knowledge base. Please try again.';
        }
      },
      toolSchema: {
        name: 'search_knowledge_base',
        description:
          "Semantic search over the user's knowledge base. Ranks documents by MEANING (embeddings) and returns the most relevant passage CONTENT inline — so you can usually answer directly from the results without any further calls. Use a clear natural-language query describing what you need; you do NOT need to know exact tags. Make ONE good search per distinct topic, then compose your answer.",
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Natural-language description of what you need (e.g. "product specs, pricing tiers, key features, use cases"). Ranked by semantic similarity — be descriptive.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description:
                'OPTIONAL narrowing filter — semantic ranking already finds the right docs, so usually omit this. If you do filter, use a real tag (matching is partial + case-insensitive), e.g. "acme:vertical:pharma" or "acme:type:product-spec".',
            },
            file_type: {
              type: 'string',
              enum: ['pdf', 'text', 'image', 'excel', 'word', 'json', 'csv', 'markdown', 'code', 'url'],
              description: 'Optional: filter results by file type',
            },
            max_results: {
              type: 'number',
              // This schema is built synchronously (see the comment on KB_SEARCH_MAX_RESULTS
              // above), so it cannot read the live kbSearchDefaultResults setting. Omitting the
              // default rather than stating the coded one avoids the model reading a stale number
              // and passing it explicitly as max_results, which would bypass an admin's raised
              // default on every such call.
              description: `Maximum number of results to return (max: ${KB_SEARCH_MAX_RESULTS})`,
              minimum: 1,
              maximum: KB_SEARCH_MAX_RESULTS,
            },
          },
          required: ['query'],
        },
      },
    };
  },
};
