import { ToolContext, ToolDefinition } from '../../base/types';
import {
  CitableSource,
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
import type { Logger } from '@bike4mind/observability';
import { getDynamicDataLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';
import { datalakeTagsFrom } from '../../../../dataLakeService/getDataLakePrompts';
import { prependRetrievedLakePrompts } from '../retrievedLakePrompts';
import {
  describeEmbeddingMismatch,
  PARTIAL_RESULTS_STATUS_SUFFIX,
} from '../../../../dataLakeService/embeddingMismatch';
import {
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  SemanticChunkResult,
  type SemanticSearchBudgets,
  type SemanticSearchScanAccounting,
} from '../../../../dataLakeService/semanticDataLakeSearch';
import { resolveSearchBudgets } from '../../../../dataLakeService/resolveSearchBudgets';
import { openSearchChunkAdapter } from '../../../../dataLakeService/openSearchChunkAdapter';
import { getEffectiveLLMApiKeys } from '../../../../apiKeyService';
import { recordOperationalUsage } from '../../../../billing';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';

const CHUNK_TEXT_CAP = 1200;

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

/** Format semantic passages WITH their content so the model can answer without retrieving. */
function formatSemanticResults(
  results: SemanticChunkResult[],
  scan?: SemanticSearchScanAccounting,
  skipNotice?: string | null
): string {
  const blocks = results.map((r, i) => {
    const text = r.chunkText.trim();
    const clipped = text.length > CHUNK_TEXT_CAP ? `${text.slice(0, CHUNK_TEXT_CAP)}…` : text;
    return `${i + 1}. **${prettyFileName(r.fileName)}** (relevance ${r.score.toFixed(2)})\n${clipped}`;
  });
  // A truncated scan ranked only part of the corpus. Say so, or the model will read "no further
  // matches" into what is really "we stopped looking" and assert the library holds nothing else.
  // filesScanned + annFilesQueried, not filesScanned alone: an Atlas-served file was searched too,
  // just never handed to the brute-force scan (see SemanticSearchScanAccounting.annFilesQueried).
  const partial = scan?.truncated
    ? `NOTE: this search covered only ${scan.filesScanned + scan.annFilesQueried} of ${scan.filesMatching} documents (a scan budget was reached), so these passages may be incomplete. Do not state or imply the knowledge base has nothing further on this topic.\n\n`
    : '';
  return (
    formatSkipNotice(skipNotice) +
    partial +
    `Found ${results.length} relevant passage(s) in the knowledge base — the content is included below, so answer directly and only call retrieve_knowledge_content if you need MORE detail from a specific file:\n\n` +
    blocks.join('\n\n---\n\n')
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
  budgets: SemanticSearchBudgets;
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
 * Record the query-embedding spend (the embed ran once regardless of hit count).
 * Isolated so a recording failure never discards a good search result.
 */
async function recordQueryEmbeddingUsage(
  context: ToolContext,
  query: string,
  embeddingModel: SupportedEmbeddingModel,
  provider: string
): Promise<void> {
  try {
    const queryTokens = await getSharedTokenizer(context.logger).countTokens(query, embeddingModel);
    const organization =
      context.user.organizationId && context.db.organizations
        ? await context.db.organizations.findById(context.user.organizationId)
        : null;
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
    context.logger.warn('📚 [semantic] failed to record embedding usage:', recordErr);
  }
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
  skipNotice?: string | null
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
    { promptMeta: { citables, ...(skipNotice ? { warnings: [skipNotice] } : {}) } } as any,
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
}

/** Nothing to report: dependency missing, no accessible corpus, or the arm threw. */
const NO_SEMANTIC_RESULT: SemanticArmResult = { output: null, skipNotice: null, datalakeTags: [] };

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

    const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await getDynamicDataLakeAccess(context);
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

    await recordQueryEmbeddingUsage(context, query, embeddingModel, provider);

    const skipNotice = describeEmbeddingMismatch(search.embeddingMismatch, search.embeddingModel);
    // No hits: the keyword arm answers, but it has to carry the notice with it.
    if (search.results.length === 0) return { output: null, skipNotice, datalakeTags: [] };

    // Honor the max_results contract: topK fetches a wider pool (≥6) so cosine ranking has
    // candidates, but we return at most maxResults passages - parity with the keyword path's
    // .slice(0, max_results) so the tool output can't exceed what the caller asked for.
    const ranked = search.results.slice(0, maxResults);

    await emitSemanticCitables(context, ranked, 'the data lake', skipNotice);
    context.logger.log(
      `📚 [semantic] returning ${ranked.length}/${search.results.length} passages from ${new Set(ranked.map(r => r.fileId)).size} files (top score ${search.results[0].score.toFixed(3)})`
    );

    // Provenance for retrieval-scoped lake-prompt injection: which lakes these passages came from.
    return {
      output: formatSemanticResults(ranked, search.scan, skipNotice),
      skipNotice,
      datalakeTags: datalakeTagsFrom(ranked.flatMap(r => r.fileTags)),
    };
  } catch (err) {
    context.logger.warn('📚 [semantic] KB search failed, falling back to keyword:', err);
    // A genuine failure must not fabricate a notice.
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

    await recordQueryEmbeddingUsage(context, query, embeddingModel, provider);

    const skipNotice = describeEmbeddingMismatch(search.embeddingMismatch, search.embeddingModel);
    if (search.results.length === 0) return { output: null, skipNotice, datalakeTags: [] };

    const ranked = search.results.slice(0, maxResults);
    await emitSemanticCitables(context, ranked, "this agent's knowledge base", skipNotice);
    // Agent-scoped results never carry a lake prompt: this arm must not consult owner-wide access
    // or imply a wider corpus, so its provenance is intentionally empty (no injection downstream).
    return { output: formatSemanticResults(ranked, search.scan, skipNotice), skipNotice, datalakeTags: [] };
  } catch (err) {
    context.logger.warn('📚 [semantic] scoped KB search failed, falling back to scoped keyword:', err);
    return NO_SEMANTIC_RESULT;
  }
}

interface KnowledgeBaseSearchParams {
  query: string;
  tags?: string[];
  file_type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
  max_results?: number;
}

/**
 * Formats fab file search results for LLM consumption
 */
function formatSearchResults(files: IFabFileDocument[]): string {
  if (files.length === 0) {
    return 'No documents found matching your search query in your knowledge base.';
  }

  const formattedFiles = files.map((file, index) => {
    const tags = file.tags?.map(t => t.name).join(', ') || 'none';
    const notes = file.notes ? `\n   Notes: ${file.notes}` : '';
    const fileType = file.type || 'FILE';

    return (
      `${index + 1}. **${file.fileName}** (ID: ${file.id})\n` +
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
    return {
      toolFn: async value => {
        const params = value as KnowledgeBaseSearchParams;
        await context.onStart?.('search_knowledge_base', params);
        const { query, tags, file_type, max_results = 5 } = params;

        searchCallCount++;
        if (searchCallCount > MAX_SEARCHES) {
          context.logger.log(
            `📚 Knowledge Base Search: call #${searchCallCount} — capped, instructing model to answer`
          );
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
          return 'Knowledge base search is not available at this time.';
        }

        // Agent-scoped KB restriction (see KbScope). An empty scope reads NOTHING - return
        // the generic no-results message before either arm runs, never fall back owner-wide.
        const scope = context.kbScope;
        if (scope && scope.fileIds.length === 0) {
          return formatSearchResults([]);
        }

        // Semantic-first: rank by meaning and return passage CONTENT inline so the model can
        // answer without a search->retrieve loop. Falls through to keyword search below if the
        // embedding deps aren't wired or nothing matches. The scoped arm never consults
        // owner-wide data-lake access.
        const semantic = scope
          ? await tryScopedSemanticKbSearch(context, scope.fileIds, query, max_results)
          : await trySemanticKbSearch(context, query, tags, max_results);
        lastSkipNotice = semantic.skipNotice;
        // Attach the retrieved lakes' scoped prompts (no-op for the agent-scoped arm, whose
        // datalakeTags are empty). The keyword fallback below returns metadata only (no grounded
        // content), so a lake prompt rides only actual retrieved content; the keyword path's content
        // enters later via retrieve_knowledge_content, which injects there. Test .output, not the
        // object: the arm always resolves to a truthy result now, so `if (semantic)` would swallow
        // the keyword fallback entirely.
        if (semantic.output)
          return prependRetrievedLakePrompts(context, semantic.output, semantic.datalakeTags, injectedLakeTags);

        try {
          let searchResults;
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
            const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await getDynamicDataLakeAccess(context);
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
            .slice(0, max_results)
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
              { promptMeta: { citables, ...(semantic.skipNotice ? { warnings: [semantic.skipNotice] } : {}) } } as any,
              foundStatus
            );
            context.logger.log(`📚 Knowledge Base Search: Stored ${citables.length} citables`);
          } else {
            // No hits - tell the user what was searched so the wait reads as deliberate.
            const clippedQuery = query.length > 50 ? query.slice(0, 49) + '…' : query;
            const skipSuffix = semantic.skipNotice ? PARTIAL_RESULTS_STATUS_SUFFIX : '';
            await context.statusUpdate(
              { promptMeta: semantic.skipNotice ? { warnings: [semantic.skipNotice] } : {} } as any,
              (scope
                ? `📭 No matches in this agent's knowledge base for "${clippedQuery}"`
                : `📭 No data-lake matches for "${clippedQuery}" - broadening...`) + skipSuffix
            );
          }

          return formatSearchResults(rankedResults) + formatSkipNotice(semantic.skipNotice);
        } catch (error) {
          context.logger.error('❌ Knowledge Base Search: Error during search:', error);
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
              description: 'Maximum number of results to return (default: 5, max: 10)',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['query'],
        },
      },
    };
  },
};
