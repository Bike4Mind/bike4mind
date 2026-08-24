import { KbScope, ToolContext, ToolDefinition } from '../../base/types';
import {
  CitableSource,
  getEmbeddingModelCost,
  IFabFileDocument,
  isSupportedEmbeddingModel,
  KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
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
import { getDynamicDataLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';
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
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  SemanticChunkResult,
  type SemanticSearchScanAccounting,
} from '../../../../dataLakeService/semanticDataLakeSearch';
import {
  positiveIntOr,
  resolveSearchBudgets,
  type ResolvedSearchBudgets,
} from '../../../../dataLakeService/resolveSearchBudgets';
import { openSearchChunkAdapter } from '../../../../dataLakeService/openSearchChunkAdapter';
import { attributeAccessedLakeIds, type AttributableLake } from '../../../../dataLakeService/attributeAccessedLakes';
import { recordLakeAccessEvent } from '../../../../dataLakeService/recordLakeAccessEvent';
import { getEffectiveLLMApiKeys } from '../../../../apiKeyService';
import { recordOperationalUsage } from '../../../../billing';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';

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
 * Cut to a budget without splitting a character. `slice` counts UTF-16 code units, so a cut at an
 * arbitrary index can land between the halves of a surrogate pair (emoji, supplementary-plane CJK)
 * and emit a lone surrogate - a corrupted final character in the text the model reads, and one that
 * survives into anything quoting the passage back. Dropping the orphaned half costs one character of
 * an already-truncated passage.
 */
function clipToCodePointBoundary(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  const endsOnOrphanedHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return endsOnOrphanedHighSurrogate ? sliced.slice(0, -1) : sliced;
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
 */
function formatSemanticResults(
  results: SemanticChunkResult[],
  maxChunkChars: number,
  scan?: SemanticSearchScanAccounting,
  skipNotice?: string | null,
  logger?: Logger
): string {
  let clippedCount = 0;
  let longestChars = 0;
  const blocks = results.map((r, i) => {
    // Measured AFTER trim on purpose: the budget governs what this function emits, and the trimmed
    // string is what it emits. A padded chunk that fits once trimmed is served whole, correctly.
    const text = r.chunkText.trim();
    longestChars = Math.max(longestChars, text.length);
    // Clip BEFORE defanging, never after: defang indents line-initial markers, so slicing the
    // defanged string would spend part of the content budget on the defense itself.
    const overBudget = text.length > maxChunkChars;
    if (overBudget) clippedCount++;
    const clipped = overBudget ? `${clipToCodePointBoundary(text, maxChunkChars)}\u2026` : text;
    // The file name is content-adjacent and equally attacker-influenced: without toContentLabel a
    // crafted name carries a newline plus a forged marker into the label line.
    return (
      `${i + 1}. **${toContentLabel(prettyFileName(r.fileName))}** (relevance ${r.score.toFixed(2)})\n` +
      defangRetrievedContent(clipped)
    );
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
  return (
    formatSkipNotice(skipNotice) +
    partial +
    truncated +
    `Found ${results.length} relevant passage(s) in the knowledge base — the content is included below, so answer directly and only call retrieve_knowledge_content if you need MORE detail from a specific file:\n\n` +
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
  budgets: ResolvedSearchBudgets;
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

  const budgets = await resolveSearchBudgets({ adminSettings }, context.logger);
  const vectorSearchEnabled = (await adminSettings.getSettingsValue('EnableDataLakeVectorSearch')) ?? false;

  return { embeddingModel, provider, apiKeyTable, budgets, vectorSearchEnabled };
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
}

/** Nothing to report: dependency missing, no accessible corpus, or the arm threw. */
const NO_SEMANTIC_RESULT: SemanticArmResult = {
  output: null,
  skipNotice: null,
  datalakeTags: [],
  fileHits: [],
  lakeIds: [],
  chunkIds: [],
  scores: [],
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
  maxResults: number
): Promise<SemanticArmResult> {
  const chunkRepo = context.db.fabfilechunks;
  if (!context.db.fabfiles || !chunkRepo?.findVectorsByFabFileIds) {
    context.logger.warn('📚 [semantic] falling back to keyword search: fabfiles/fabfilechunks not wired');
    return NO_SEMANTIC_RESULT; // semantic deps not wired - use keyword
  }
  try {
    const embedCtx = await resolveEmbeddingContext(context);
    if (!embedCtx) return NO_SEMANTIC_RESULT;
    const { embeddingModel, provider, apiKeyTable, budgets, vectorSearchEnabled } = embedCtx;

    const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes, lakes } = await getDynamicDataLakeAccess(context);
    // No accessible data lake - keyword search owns the user's own files.
    if (dataLakeTags.length === 0) return NO_SEMANTIC_RESULT;

    const search = await semanticDataLakeSearch(
      {
        userId: context.userId,
        userGroups: context.user.groups ?? [],
        query,
        tags,
        topK: Math.max(maxResults, 6),
        minScore: 0,
        embeddingModel,
        apiKeyTable,
        dataLakeTags,
        dataLakeTagPrefixes,
        scopedTagPrefixes,
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

    const skipNotice = describeSearchLimitations(search);
    // No hits: the keyword arm answers, but it has to carry the notice with it.
    if (search.results.length === 0)
      return { output: null, skipNotice, datalakeTags: [], fileHits: [], lakeIds: [], chunkIds: [], scores: [] };

    // Honor the max_results contract: topK fetches a wider pool (>=6) so cosine ranking has
    // candidates, but we return at most maxResults passages - parity with the keyword path's
    // .slice(0, maxResults) so the tool output can't exceed what the caller asked for. The
    // value arrives already clamped to KB_SEARCH_MAX_RESULTS; this arm must not re-derive it.
    const ranked = search.results.slice(0, maxResults);

    await emitSemanticCitables(context, ranked, 'the data lake', skipNotice, dataLakeTags);
    context.logger.log(
      `📚 [semantic] returning ${ranked.length}/${search.results.length} passages from ${new Set(ranked.map(r => r.fileId)).size} files (top score ${search.results[0].score.toFixed(3)})`
    );

    // Provenance for retrieval-scoped lake-prompt injection: which lakes these passages came from.
    return {
      output: formatSemanticResults(ranked, budgets.maxChunkChars, search.scan, skipNotice, context.logger),
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
  maxResults: number
): Promise<SemanticArmResult> {
  const chunkRepo = context.db.fabfilechunks;
  if (!context.db.fabfiles || !chunkRepo?.findVectorsByFabFileIds) {
    context.logger.warn('📚 [semantic] falling back to keyword search: fabfiles/fabfilechunks not wired');
    return NO_SEMANTIC_RESULT;
  }
  try {
    const embedCtx = await resolveEmbeddingContext(context);
    if (!embedCtx) return NO_SEMANTIC_RESULT;
    const { embeddingModel, provider, apiKeyTable, budgets, vectorSearchEnabled } = embedCtx;

    const search = await fileScopedSemanticSearch(
      {
        query,
        fileIds: scopeFileIds,
        topK: Math.max(maxResults, 6),
        minScore: 0,
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

    const skipNotice = describeSearchLimitations(search);
    if (search.results.length === 0)
      return { output: null, skipNotice, datalakeTags: [], fileHits: [], lakeIds: [], chunkIds: [], scores: [] };

    const ranked = search.results.slice(0, maxResults);
    await emitSemanticCitables(context, ranked, "this agent's knowledge base", skipNotice, []);
    // Agent-scoped results never carry a lake prompt: this arm must not consult owner-wide access
    // or imply a wider corpus, so its provenance is intentionally empty (no injection downstream).
    return {
      output: formatSemanticResults(ranked, budgets.maxChunkChars, search.scan, skipNotice, context.logger),
      skipNotice,
      datalakeTags: [],
      fileHits: ranked.map(r => ({ id: r.fileId, fileName: r.fileName })),
      lakeIds: [],
      chunkIds: ranked.map(r => r.chunkId),
      scores: ranked.map(r => r.score),
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
 * The admin's configured `kbSearchDefaultResults`, or the coded default on anything unusable.
 * Mirrors `resolveForcedRetrievalCharBudget` in `ChatCompletionFeatures.ts`: same try/catch
 * shape, same loud-fallback policy, same "resolved once per turn" discipline enforced by the
 * caller (see the closure-scoped cache in `knowledgeBaseSearchTool.implementation`).
 */
async function resolveKbSearchDefaultResults(context: ToolContext): Promise<number> {
  try {
    const configured = await context.db.adminSettings.getSettingsValue('kbSearchDefaultResults');
    return positiveIntOr(
      configured as string | number | null | undefined,
      KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
      'kbSearchDefaultResults',
      context.logger
    );
  } catch (err) {
    context.logger.warn(
      `Knowledge base search: failed to read kbSearchDefaultResults; falling back to ${KB_SEARCH_DEFAULT_RESULTS_DEFAULT}`,
      err
    );
    return KB_SEARCH_DEFAULT_RESULTS_DEFAULT;
  }
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
  const safeDefault = Math.min(Math.max(defaultResults, 1), KB_SEARCH_MAX_RESULTS);
  if (raw === undefined || raw === null || raw === '') return safeDefault;
  const n = Number(raw);
  if (!Number.isFinite(n)) return safeDefault;
  return Math.min(Math.max(Math.floor(n), 1), KB_SEARCH_MAX_RESULTS);
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

    return (
      `${index + 1}. **${toContentLabel(file.fileName)}** (ID: ${file.id})\n` +
      `   Type: ${fileType} | MIME: ${file.mimeType}\n` +
      `   Tags: ${tags}${notes}`
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
    // Resolved at most once per completion, same discipline as searchCallCount above -
    // getSettingsValue is an uncached read, so a settings read on every search_knowledge_base
    // call would cost a real DB round-trip for no benefit.
    let defaultResultsPromise: Promise<number> | undefined;
    return {
      toolFn: async value => {
        const params = value as KnowledgeBaseSearchParams;
        await context.onStart?.('search_knowledge_base', params);
        const { query, tags, file_type } = params;
        defaultResultsPromise ??= resolveKbSearchDefaultResults(context);
        // Every consumer below reads maxResults, never params.max_results: one clamp at the
        // single entry point is what keeps a later edit from reopening the hole at one of them.
        const maxResults = clampMaxResults(params.max_results, await defaultResultsPromise);

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
        // One effective scope from two sources, so every downstream branch that keys on `scope`
        // (the semantic arm AND its keyword fallback) narrows together. Scoping only the semantic
        // arm would let the keyword fallback re-widen to owner-wide lake access on the exact turns
        // the semantic arm found nothing.
        //
        // kbScope wins when both are set: it is the stricter, fail-closed agent restriction. The
        // personal-corpus source is normalized to `undefined` when empty rather than to an empty
        // scope, because an empty scope means "read NOTHING" here - see personalCorpusFileIds.
        const scope: KbScope | undefined =
          context.kbScope ??
          (context.personalCorpusFileIds?.length ? { fileIds: context.personalCorpusFileIds } : undefined);
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
          ? await tryScopedSemanticKbSearch(context, scope.fileIds, query, maxResults)
          : await trySemanticKbSearch(context, query, tags, maxResults);
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
            const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes, lakes } =
              await getDynamicDataLakeAccess(context);
            keywordArmLakes = lakes;
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
                scopedTagPrefixes, // Dynamic-lake prefixes — matched only within owner/org access
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
            const corpusLabel = scope ? "this agent's knowledge base" : 'the data lake';
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
                    outcome: 'ok',
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
                  // Ran to completion and legitimately found nothing - must be distinguishable
                  // from "never searched" (#1867).
                  retrieval: {
                    attempted: true,
                    outcome: 'ok',
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
