import { ToolContext, ToolDefinition } from '../../base/types';
import {
  CitableSource,
  getEmbeddingModelCost,
  IFabFileDocument,
  isSupportedEmbeddingModel,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { createTokenizer, getProviderFromModel, getSettingsByNames, type ITokenizer } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { getDynamicDataLakeAccess } from '../../../../dataLakeService/getDynamicDataLakeTags';
import { semanticDataLakeSearch, SemanticChunkResult } from '../../../../dataLakeService/semanticDataLakeSearch';
import { getEffectiveLLMApiKeys } from '../../../../apiKeyService';
import { recordOperationalUsage } from '../../../../billing';

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
function formatSemanticResults(results: SemanticChunkResult[]): string {
  const blocks = results.map((r, i) => {
    const text = r.chunkText.trim();
    const clipped = text.length > CHUNK_TEXT_CAP ? `${text.slice(0, CHUNK_TEXT_CAP)}…` : text;
    return `${i + 1}. **${prettyFileName(r.fileName)}** (relevance ${r.score.toFixed(2)})\n${clipped}`;
  });
  return (
    `Found ${results.length} relevant passage(s) in the knowledge base — the content is included below, so answer directly and only call retrieve_knowledge_content if you need MORE detail from a specific file:\n\n` +
    blocks.join('\n\n---\n\n')
  );
}

/**
 * Semantic-first KB search: embed the query and cosine-rank against the pre-computed chunk
 * vectors (tag-independent, ranks by meaning), returning the matching passage TEXT inline so
 * the model answers without a search->retrieve-N loop. Returns null to fall through to the
 * keyword path when embedding deps are unavailable or nothing matches.
 */
async function trySemanticKbSearch(
  context: ToolContext,
  query: string,
  tags: string[] | undefined,
  maxResults: number
): Promise<string | null> {
  const chunkRepo = context.db.fabfilechunks;
  const adminSettings = context.db.adminSettings;
  const apiKeys = context.db.apiKeys;
  if (!context.db.fabfiles || !chunkRepo?.findVectorsByFabFileIds || !adminSettings || !apiKeys) {
    return null; // semantic deps not wired — use keyword
  }
  try {
    const modelRaw = await adminSettings.getSettingsValue('defaultEmbeddingModel');
    if (!modelRaw || !isSupportedEmbeddingModel(modelRaw)) return null;
    const embeddingModel = modelRaw as SupportedEmbeddingModel;

    const apiKeyTable = await getEffectiveLLMApiKeys(
      context.userId,
      { db: { apiKeys, adminSettings }, getSettingsByNames },
      { logger: context.logger }
    );
    const provider = getProviderFromModel(embeddingModel);
    if (provider === 'openai' && !apiKeyTable?.openai) return null;
    if (provider === 'voyageai' && !apiKeyTable?.voyageai) return null;
    // Ollama base URL lives in apiKeyTable.ollama (self-host); without it, fall back to keyword.
    if (provider === 'ollama' && !apiKeyTable?.ollama) return null;

    const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await getDynamicDataLakeAccess(context);
    if (dataLakeTags.length === 0) return null; // no accessible data lake — keyword search owns the user's own files

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
        logger: context.logger,
      },
      { db: { fabfiles: context.db.fabfiles, fabfilechunks: chunkRepo } }
    );

    // Record the query-embedding spend (the embed ran once above regardless of hit count).
    // Isolated so a recording failure never discards a good search result.
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
        { db: { usageEvents: context.db.usageEvents, adminSettings }, logger: context.logger }
      );
    } catch (recordErr) {
      context.logger.warn('📚 [semantic] failed to record embedding usage:', recordErr);
    }

    if (search.results.length === 0) return null;

    // Honor the max_results contract: topK fetches a wider pool (≥6) so cosine ranking has
    // candidates, but we return at most maxResults passages - parity with the keyword path's
    // .slice(0, max_results) so the tool output can't exceed what the caller asked for.
    const ranked = search.results.slice(0, maxResults);

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
    await context.statusUpdate(
      { promptMeta: { citables } } as any,
      `📄 Found ${citables.length} relevant doc(s) in the data lake: ${names.join(', ')}${more}`
    );
    context.logger.log(
      `📚 [semantic] returning ${ranked.length}/${search.results.length} passages from ${citables.length} files (top score ${search.results[0].score.toFixed(3)})`
    );

    return formatSemanticResults(ranked);
  } catch (err) {
    context.logger.warn('📚 [semantic] KB search failed, falling back to keyword:', err);
    return null;
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
            `or retrieve_knowledge_content again unless a specific named fact is genuinely missing.`
          );
        }

        context.logger.log('📚 Knowledge Base Search: userId:', context.userId, 'query:', query, 'tags:', tags);

        if (!context.db.fabfiles) {
          context.logger.error('❌ Knowledge Base Search: fabfiles repository not available');
          return 'Knowledge base search is not available at this time.';
        }

        // Semantic-first: rank by meaning and return passage CONTENT inline so the model can
        // answer without a search->retrieve loop. Falls through to keyword search below if the
        // embedding deps aren't wired or nothing matches.
        const semantic = await trySemanticKbSearch(context, query, tags, max_results);
        if (semantic) return semantic;

        try {
          // Search files the user has access to (owned + shared + org-shared + data lake)
          const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await getDynamicDataLakeAccess(context);
          const searchResults = await context.db.fabfiles.search(
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
            }
          );

          // Dedup (the lake can contain duplicate uploads) and relevance-rank by how well each
          // file's metadata matches the query - since the underlying search sorts by fileName
          // ASC, the most relevant files would otherwise be buried. Metadata-only proxy ranking;
          // true semantic (embedding) ranking is the planned follow-up.
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
          const rankedResults = searchResults.data
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
            const foundStatus = `📄 Found ${rankedResults.length} in the data lake: ${names.join(', ')}${more}`;
            await context.statusUpdate({ promptMeta: { citables } } as any, foundStatus);
            context.logger.log(`📚 Knowledge Base Search: Stored ${citables.length} citables`);
          } else {
            // No hits - tell the user what was searched so the wait reads as deliberate.
            await context.statusUpdate(
              {} as any,
              `📭 No data-lake matches for “${query.length > 50 ? query.slice(0, 49) + '…' : query}” — broadening…`
            );
          }

          return formatSearchResults(rankedResults);
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
