/**
 * Shared help-content retrieval.
 *
 * Extracted from `pages/api/help/chat.ts` so it can be reused by BOTH the help chat endpoint
 * (which wraps the retrieved context in a help-assistant system prompt and calls an LLM) and the
 * retrieval-only `pages/api/help/search.ts` endpoint (consumed by the chat `help_search` tool).
 *
 * Retrieval stays in the Next.js app on purpose: the embeddings index (`app/generated/
 * help-embeddings.json`) and bundled markdown (`public/help-content/`) are app assets read via
 * `process.cwd()`. The LLM completion workers (questProcessor/agentExecutor) run in separate
 * Lambdas without those files, so they reach this logic over HTTP rather than importing it.
 *
 * Strategy: vector similarity search over pre-computed embeddings, with a keyword fallback when
 * embeddings are unavailable or no API key is present for the query embedding.
 */

import { computeCosineSimilarity } from '@bike4mind/utils';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import type { HelpIndex, HelpIndexEntry, HelpEmbeddingsIndex, HelpEmbeddingChunk } from '@bike4mind/scripts/help/types';
import { chunkByHeadings, stripFrontmatter, truncateAndNormalize } from '@bike4mind/scripts/help/utils';
import fs from 'fs';
import path from 'path';

// --- Vector search constants ---
/** Token budget for help context */
const MAX_CONTEXT_TOKENS = 4000;
/** Initial candidates before budget filtering */
const TOP_K_CANDIDATES = 6;
/** Cosine similarity threshold */
const MIN_SIMILARITY = 0.3;
/** Similarity bonus applied to chunks from the article the user is currently viewing */
const CURRENT_ARTICLE_BOOST = 0.1;
/** Max relevant articles to return as links */
const MAX_RELEVANT_ARTICLES = 3;
/** Minimum best-chunk similarity for an article to appear in the "Related articles" links */
const MIN_ARTICLE_LINK_SIMILARITY = 0.45;

// --- Keyword fallback constants ---
/** Max characters of help article content to include (keyword fallback only) */
const MAX_CONTENT_LENGTH = 4000;
/** Max number of relevant help entries to include (keyword fallback only) */
const MAX_RELEVANT_ENTRIES = 3;

/** Module-level caches for static generated files (safe to cache for process lifetime). */
let helpIndexCache: HelpIndex | null = null;
const helpContentCache = new Map<string, string | null>();
let embeddingsCache: HelpEmbeddingsIndex | null = null;

export interface HelpLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface RelevantArticle {
  slug: string;
  title: string;
}

/** The subset of the effective LLM API key table needed to embed the query. */
export interface HelpEmbeddingApiKeys {
  openai?: string | null;
  voyageai?: string | null;
}

interface RankedChunk {
  chunk: HelpEmbeddingChunk;
  similarity: number;
}

interface VectorSearchResult {
  chunks: RankedChunk[];
  /** Best similarity across ALL chunks (even below threshold), for debugging */
  bestSimilarity: number;
  /** Total chunks that passed MIN_SIMILARITY threshold */
  aboveThreshold: number;
}

/** Result of a help retrieval: the documentation context block plus the articles to link. */
export interface HelpSearchResult {
  /** Markdown "## Relevant Documentation" block, or '' when nothing relevant was found. */
  context: string;
  /** Articles to surface as clickable links / deep-link targets. */
  relevantArticles: RelevantArticle[];
  /** Which strategy produced the result. */
  method: 'vector' | 'keyword' | 'none';
}

// ===========================
// Embeddings loading
// ===========================

async function loadHelpEmbeddings(logger: HelpLogger): Promise<HelpEmbeddingsIndex | null> {
  if (embeddingsCache) return embeddingsCache;
  try {
    const embeddingsPath = path.join(process.cwd(), 'app/generated/help-embeddings.json');
    const content = await fs.promises.readFile(embeddingsPath, 'utf-8');
    embeddingsCache = JSON.parse(content) as HelpEmbeddingsIndex;
    logger.info(`[HelpRetrieval] Loaded ${embeddingsCache.chunks.length} embedding chunks`);
    return embeddingsCache;
  } catch {
    logger.warn('[HelpRetrieval] help-embeddings.json not found, will use keyword fallback');
    return null;
  }
}

// ===========================
// Vector similarity search
// ===========================

/** Determine allowed access levels based on admin status. */
function getAllowedAccessLevels(isAdmin: boolean): Set<string> {
  return isAdmin ? new Set(['public', 'admin']) : new Set(['public']);
}

function vectorSearch(
  queryEmbedding: number[],
  embeddings: HelpEmbeddingsIndex,
  currentHelpSlug: string | undefined,
  isAdmin: boolean
): VectorSearchResult {
  const allowedLevels = getAllowedAccessLevels(isAdmin);

  const scored: RankedChunk[] = [];
  let bestSimilarity = -1;
  for (const chunk of embeddings.chunks) {
    if (!allowedLevels.has(chunk.accessLevel)) continue;

    let similarity = computeCosineSimilarity(queryEmbedding, chunk.vector);
    if (similarity > bestSimilarity) bestSimilarity = similarity;
    if (currentHelpSlug && chunk.slug === currentHelpSlug) {
      similarity = Math.min(similarity + CURRENT_ARTICLE_BOOST, 1);
    }
    if (similarity >= MIN_SIMILARITY) {
      scored.push({ chunk, similarity });
    }
  }

  const aboveThreshold = scored.length;
  scored.sort((a, b) => b.similarity - a.similarity);
  const candidates = scored.slice(0, TOP_K_CANDIDATES);

  // Greedily fill the token budget, favouring higher-ranked chunks.
  const selected: RankedChunk[] = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    const chunkTokens = candidate.chunk.tokenCount;
    if (usedTokens + chunkTokens > MAX_CONTEXT_TOKENS) continue;
    selected.push(candidate);
    usedTokens += chunkTokens;
  }

  return { chunks: selected, bestSimilarity, aboveThreshold };
}

/**
 * Resolve article content for vector search results. The embeddings file stores only vectors,
 * so we load the original markdown, re-chunk it, and match by sectionPath.
 */
async function resolveChunkContent(rankedChunks: RankedChunk[], logger: HelpLogger): Promise<Map<string, string>> {
  const contentMap = new Map<string, string>();
  const slugs = [...new Set(rankedChunks.map(rc => rc.chunk.slug))];

  for (const slug of slugs) {
    const rawContent = await loadHelpContent(slug, logger);
    if (!rawContent) continue;

    const markdown = stripFrontmatter(rawContent);
    const title = rankedChunks.find(rc => rc.chunk.slug === slug)!.chunk.title;
    const sections = chunkByHeadings(markdown, title);

    for (const section of sections) {
      const key = `${slug}::${section.sectionPath}`;
      contentMap.set(key, `# ${title}\n\n${section.content}`);
    }
  }

  return contentMap;
}

function buildVectorContext(rankedChunks: RankedChunk[], contentMap: Map<string, string>): string {
  if (rankedChunks.length === 0) return '';

  let context = '\n\n## Relevant Documentation:\n\n';
  for (const { chunk } of rankedChunks) {
    const key = `${chunk.slug}::${chunk.sectionPath}`;
    const content = contentMap.get(key);
    if (!content) continue;
    context += `### ${chunk.title} — ${chunk.sectionPath}\n`;
    context += content + '\n\n';
  }
  return context;
}

// ===========================
// Keyword fallback
// ===========================

async function loadHelpIndex(logger: HelpLogger): Promise<HelpIndex | null> {
  if (helpIndexCache) return helpIndexCache;
  try {
    const indexPath = path.join(process.cwd(), 'app/generated/help-index.json');
    const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
    helpIndexCache = JSON.parse(indexContent) as HelpIndex;
    return helpIndexCache;
  } catch (error) {
    logger.warn('[HelpRetrieval] Failed to load help index:', error);
    return null;
  }
}

function findRelevantHelpEntries(question: string, helpIndex: HelpIndex, isAdmin: boolean): HelpIndexEntry[] {
  const allowedLevels = getAllowedAccessLevels(isAdmin);
  const questionWords = question
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  const scored = helpIndex.entries
    .filter(e => allowedLevels.has(e.accessLevel))
    .map(entry => {
      let score = 0;
      const searchableText = [entry.title, entry.description, ...entry.tags, ...entry.headings.map(h => h.text)]
        .join(' ')
        .toLowerCase();

      for (const word of questionWords) {
        if (searchableText.includes(word)) {
          score += 1;
          if (entry.title.toLowerCase().includes(word)) score += 2;
          if (entry.tags.some(t => t.toLowerCase().includes(word))) score += 1;
        }
      }

      return { entry, score };
    });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_ENTRIES)
    .map(s => s.entry);
}

/**
 * Load the content of a help article by slug. Tries `${slug}.md` then `${slug}/index.md`.
 */
async function loadHelpContent(slug: string, logger: HelpLogger): Promise<string | null> {
  if (helpContentCache.has(slug)) return helpContentCache.get(slug)!;

  try {
    const helpContentRoot = path.resolve(process.cwd(), 'public/help-content');
    const candidates = [`${slug}.md`, `${slug}/index.md`];
    for (const candidate of candidates) {
      const contentPath = path.resolve(helpContentRoot, candidate);
      // Prevent path traversal
      if (!contentPath.startsWith(helpContentRoot + path.sep)) {
        logger.warn(`[HelpRetrieval] Path traversal attempt blocked for slug: ${slug}`);
        return null;
      }
      try {
        const content = await fs.promises.readFile(contentPath, 'utf-8');
        helpContentCache.set(slug, content);
        return content;
      } catch {
        // Try next candidate
      }
    }

    if (helpIndexCache?.entries.some(e => e.slug === slug)) {
      logger.warn(
        `[HelpRetrieval] Help content file missing for indexed slug "${slug}". ` +
          'Run "pnpm --filter @bike4mind/scripts help:bundle-content" to generate help content.'
      );
    }
    helpContentCache.set(slug, null);
    return null;
  } catch {
    helpContentCache.set(slug, null);
    return null;
  }
}

function buildKeywordContext(relevantEntries: HelpIndexEntry[], helpContents: (string | null)[]): string {
  if (relevantEntries.length === 0) return '';

  let context = '\n\n## Relevant Documentation:\n\n';
  for (let i = 0; i < relevantEntries.length; i++) {
    const entry = relevantEntries[i];
    const content = helpContents[i];
    context += `### ${entry.title}\n`;
    if (content) {
      const truncatedContent =
        content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) + '...' : content;
      context += truncatedContent + '\n\n';
    } else {
      context += `${entry.description}\n\n`;
    }
  }
  return context;
}

async function keywordFallback(
  question: string,
  currentHelpSlug: string | undefined,
  isAdmin: boolean,
  logger: HelpLogger
): Promise<{ context: string; relevantArticles: RelevantArticle[] }> {
  const helpIndex = await loadHelpIndex(logger);

  let relevantEntries: HelpIndexEntry[] = [];
  if (helpIndex) {
    relevantEntries = findRelevantHelpEntries(question, helpIndex, isAdmin);

    // If the user is viewing a specific help article, prioritize it.
    if (currentHelpSlug) {
      const currentEntry = helpIndex.entries.find(e => e.slug === currentHelpSlug);
      if (currentEntry && !relevantEntries.some(e => e.slug === currentHelpSlug)) {
        relevantEntries.unshift(currentEntry);
        relevantEntries = relevantEntries.slice(0, MAX_RELEVANT_ENTRIES);
      }
    }
  }

  logger.info(`[HelpRetrieval] Keyword fallback: ${relevantEntries.length} entries`);

  const helpContents = await Promise.all(relevantEntries.map(entry => loadHelpContent(entry.slug, logger)));
  const relevantArticles = relevantEntries.slice(0, MAX_RELEVANT_ARTICLES).map(e => ({ slug: e.slug, title: e.title }));
  return { context: buildKeywordContext(relevantEntries, helpContents), relevantArticles };
}

// ===========================
// Orchestrator
// ===========================

/**
 * Retrieve help documentation context for a question. Tries vector search first (needs the
 * embeddings index + an API key for the query embedding) and falls back to keyword matching.
 *
 * Returns the raw documentation context block and the articles to link - callers decide how to
 * use them (wrap in a system prompt + LLM, or hand straight to a tool).
 */
export async function searchHelpContext(params: {
  question: string;
  currentHelpSlug?: string;
  isAdmin: boolean;
  apiKeys: HelpEmbeddingApiKeys | null | undefined;
  logger: HelpLogger;
}): Promise<HelpSearchResult> {
  const { question, currentHelpSlug, isAdmin, apiKeys, logger } = params;

  const embeddingsIndex = await loadHelpEmbeddings(logger);

  if (embeddingsIndex) {
    try {
      // Must use the SAME model that generated the stored embeddings; a different model produces
      // vectors in a different space, making cosine similarity meaningless.
      const embeddingModel = embeddingsIndex.model;

      if (!isSupportedEmbeddingModel(embeddingModel)) {
        logger.warn(`[HelpRetrieval] Embeddings model "${embeddingModel}" unsupported, using keyword search`);
      } else {
        const requiredProvider = getProviderFromModel(embeddingModel);
        const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
        if (requiredProvider === 'openai' && apiKeys?.openai) {
          embeddingConfig.openaiApiKey = apiKeys.openai;
        } else if (requiredProvider === 'voyageai' && apiKeys?.voyageai) {
          embeddingConfig.voyageApiKey = apiKeys.voyageai;
        }

        if (embeddingConfig.openaiApiKey || embeddingConfig.voyageApiKey) {
          const embeddingFactory = new EmbeddingFactory(embeddingConfig);
          const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);

          const fullQueryEmbedding = await embeddingService.generateEmbedding(question);
          const queryEmbedding = truncateAndNormalize(fullQueryEmbedding, embeddingsIndex.dimensions);
          const searchResult = vectorSearch(queryEmbedding, embeddingsIndex, currentHelpSlug, isAdmin);

          logger.info(
            `[HelpRetrieval] Vector search: ${searchResult.chunks.length} chunks, ${searchResult.aboveThreshold} above threshold, best ${searchResult.bestSimilarity.toFixed(3)}`
          );

          if (searchResult.chunks.length > 0) {
            const contentMap = await resolveChunkContent(searchResult.chunks, logger);
            const context = buildVectorContext(searchResult.chunks, contentMap);

            const articleBest = new Map<string, { title: string; similarity: number }>();
            for (const { chunk, similarity } of searchResult.chunks) {
              const existing = articleBest.get(chunk.slug);
              if (!existing || similarity > existing.similarity) {
                articleBest.set(chunk.slug, { title: chunk.title, similarity });
              }
            }
            const relevantArticles = [...articleBest.entries()]
              .filter(([, info]) => info.similarity >= MIN_ARTICLE_LINK_SIMILARITY)
              .sort((a, b) => b[1].similarity - a[1].similarity)
              .slice(0, MAX_RELEVANT_ARTICLES)
              .map(([slug, info]) => ({ slug, title: info.title }));

            if (context) return { context, relevantArticles, method: 'vector' };
          }
        } else {
          logger.warn(`[HelpRetrieval] No API key for ${requiredProvider}; using keyword search`);
        }
      }
    } catch (vectorError) {
      logger.warn('[HelpRetrieval] Vector search failed, using keyword search:', vectorError);
    }
  }

  // Keyword fallback
  const fallback = await keywordFallback(question, currentHelpSlug, isAdmin, logger);
  return {
    context: fallback.context,
    relevantArticles: fallback.relevantArticles,
    method: fallback.context ? 'keyword' : 'none',
  };
}
