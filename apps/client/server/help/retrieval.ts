/**
 * Shared help-content retrieval.
 *
 * Extracted from `pages/api/help/chat.ts`, which wraps the retrieved context in a help-assistant
 * system prompt and calls an LLM. That is the only consumer today - the second one this was split
 * for, a retrieval-only `pages/api/help/search.ts` behind a `help_search` chat tool, no longer
 * exists. The split is still worth keeping for the reason below, not for a second caller.
 *
 * Retrieval stays in the Next.js app on purpose: the embeddings index (`app/generated/
 * help-embeddings.json`) and the bundled markdown are app assets read via `process.cwd()`. The
 * LLM completion workers (questProcessor/agentExecutor) run in separate Lambdas without those
 * files, so they reach this logic over HTTP rather than importing it.
 *
 * The markdown lives in TWO roots split by access level: public articles in `public/help-content/`
 * (also served as static assets), admin-only articles in the server-only `app/generated/
 * help-content-admin/` - out of `public/` so Next cannot serve them unauthenticated. See
 * helpContentRoots below; the matching authenticated read path is `pages/api/help/content.ts`.
 *
 * Strategy: vector similarity search over pre-computed embeddings, with a keyword fallback when
 * embeddings are unavailable or no API key is present for the query embedding.
 */

import { computeCosineSimilarity } from '@bike4mind/utils';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import type { HelpIndex, HelpIndexEntry, HelpEmbeddingsIndex, HelpEmbeddingChunk } from '@bike4mind/scripts/help/types';
import {
  ADMIN_HELP_CONTENT_DIR,
  PUBLIC_HELP_CONTENT_DIR,
  chunkByHeadings,
  stripFrontmatter,
  truncateAndNormalize,
} from '@bike4mind/scripts/help/utils';
import { safeHelpContentPath } from './contentPath';
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
/** Keyed by contentCacheKey (access level + slug), NOT by slug - see contentCacheKey. */
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
  // Ollama base URL (self-host); keyless local embeddings.
  ollama?: string | null;
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
async function resolveChunkContent(
  rankedChunks: RankedChunk[],
  isAdmin: boolean,
  logger: HelpLogger
): Promise<Map<string, string>> {
  const contentMap = new Map<string, string>();
  const slugs = [...new Set(rankedChunks.map(rc => rc.chunk.slug))];

  for (const slug of slugs) {
    const rawContent = await loadHelpContent(slug, isAdmin, logger);
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
 * Content roots to search, in order, for a requester at this access level. The public root is
 * always allowed; the admin root is consulted ONLY for an admin requester, which is what keeps an
 * admin article's body out of a non-admin response. Both keep the docs-root-relative layout, so
 * the same slug candidates apply to either.
 *
 * The admin root must stay in sync with the bundler that writes it
 * (`packages/scripts/help/bundle-help-content.ts`) and with `pages/api/help/content.ts`, the
 * authenticated route that serves the same files to the help viewer.
 */
function helpContentRoots(isAdmin: boolean): string[] {
  const roots = [`${process.cwd()}/${PUBLIC_HELP_CONTENT_DIR}`];
  if (isAdmin) roots.push(`${process.cwd()}/${ADMIN_HELP_CONTENT_DIR}`);
  return roots;
}

/**
 * Cache key for a loaded article body. The access level is part of the key, NOT decoration: with a
 * slug-only key an admin request would warm the cache with an admin-root body that the very next
 * non-admin request for the same slug reads straight back out - re-creating the cross-access leak
 * that moving admin content out of `public/` exists to close. Do not "simplify" this to the slug.
 */
function contentCacheKey(slug: string, isAdmin: boolean): string {
  return `${isAdmin ? 'admin' : 'public'}:${slug}`;
}

/**
 * Load the content of a help article by slug. Tries `${slug}.md` then `${slug}/index.md` in each
 * root allowed at this access level (see helpContentRoots).
 *
 * Exported for the cache-isolation test: the access-keyed cache is the control that keeps admin
 * bodies out of non-admin responses, and nothing above this function can observe it.
 */
export async function loadHelpContent(slug: string, isAdmin: boolean, logger: HelpLogger): Promise<string | null> {
  const cacheKey = contentCacheKey(slug, isAdmin);
  if (helpContentCache.has(cacheKey)) return helpContentCache.get(cacheKey)!;

  try {
    // The guard is root-independent - safeHelpContentPath validates the caller-derived relative
    // path and never sees a root - so it runs once here rather than per root. Appending with a
    // template literal afterwards is what keeps the roots out of every path.* call; see
    // safeHelpContentPath for why that is load-bearing for bundle size.
    const relatives: string[] = [];
    for (const candidate of [`${slug}.md`, `${slug}/index.md`]) {
      const relative = safeHelpContentPath(candidate);
      if (!relative) {
        logger.warn(`[HelpRetrieval] Path traversal attempt blocked for slug: ${slug}`);
        return null;
      }
      relatives.push(relative);
    }

    // The loop only chooses which root's filesystem to try.
    for (const helpContentRoot of helpContentRoots(isAdmin)) {
      for (const relative of relatives) {
        try {
          const content = await fs.promises.readFile(`${helpContentRoot}/${relative}`, 'utf-8');
          helpContentCache.set(cacheKey, content);
          return content;
        } catch {
          // Try next candidate
        }
      }
    }

    if (helpIndexCache?.entries.some(e => e.slug === slug)) {
      logger.warn(
        `[HelpRetrieval] Help content file missing for indexed slug "${slug}". ` +
          'Run "pnpm --filter @bike4mind/scripts help:bundle-content" to generate help content.'
      );
    }
    helpContentCache.set(cacheKey, null);
    return null;
  } catch {
    helpContentCache.set(cacheKey, null);
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
      // currentHelpSlug is caller-supplied (pages/api/help/chat.ts), and this lookup is against
      // the UNFILTERED index, so it needs the same access check findRelevantHelpEntries applies.
      // Without it a non-admin naming an admin slug gets that article's title and description
      // echoed back - buildKeywordContext emits the title always and falls back to the
      // description when the body is null, which for a non-admin it always is.
      const allowedLevels = getAllowedAccessLevels(isAdmin);
      const currentEntry = helpIndex.entries.find(e => e.slug === currentHelpSlug);
      if (
        currentEntry &&
        allowedLevels.has(currentEntry.accessLevel) &&
        !relevantEntries.some(e => e.slug === currentHelpSlug)
      ) {
        relevantEntries.unshift(currentEntry);
        relevantEntries = relevantEntries.slice(0, MAX_RELEVANT_ENTRIES);
      }
    }
  }

  logger.info(`[HelpRetrieval] Keyword fallback: ${relevantEntries.length} entries`);

  const helpContents = await Promise.all(relevantEntries.map(entry => loadHelpContent(entry.slug, isAdmin, logger)));
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
        // Gate on a MISSING credential, not on the config being non-empty. A keyless provider
        // (Bedrock, via the AWS credential chain) correctly populates nothing, and the old
        // emptiness check read that as "no credentials" and fell through to keyword search.
        const { config: embeddingConfig, missing } = resolveEmbeddingConfig(requiredProvider, apiKeys);

        if (!missing) {
          const embeddingFactory = new EmbeddingFactory(embeddingConfig);
          const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);

          const fullQueryEmbedding = await embeddingService.generateEmbedding(question);
          const queryEmbedding = truncateAndNormalize(fullQueryEmbedding, embeddingsIndex.dimensions);
          const searchResult = vectorSearch(queryEmbedding, embeddingsIndex, currentHelpSlug, isAdmin);

          logger.info(
            `[HelpRetrieval] Vector search: ${searchResult.chunks.length} chunks, ${searchResult.aboveThreshold} above threshold, best ${searchResult.bestSimilarity.toFixed(3)}`
          );

          if (searchResult.chunks.length > 0) {
            const contentMap = await resolveChunkContent(searchResult.chunks, isAdmin, logger);
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
