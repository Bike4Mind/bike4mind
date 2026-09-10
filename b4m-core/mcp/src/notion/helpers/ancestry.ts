/**
 * Notion MCP Server - Ancestry helpers
 *
 * Shared parent-chain walking logic used by both the search and page tools.
 * Includes a short-lived, bounded cache so repeated lookups for the same page
 * (common during filtered searches) do not re-fetch from the Notion API.
 */

import type { NotionRetrieveResponse } from '../types.js';
import { notionRequest } from '../client.js';
import type { AllowedPageEntry } from '../config.js';
import { debugWarn } from '../logger.js';

export const MAX_ANCESTRY_DEPTH = 10;
export const MAX_ANCESTRY_CONCURRENCY = 3;
/** Hard wall-clock budget for a single ancestry walk, in ms. Must stay well
 *  below the mcpHandler Lambda's 20s wall-clock timeout so the deadline can
 *  actually fire; 30_000 was above that ceiling and could never preempt a walk. */
export const ANCESTRY_DEADLINE_MS = 10_000;

/** Strips dashes and lowercases a Notion UUID for stable comparison. */
export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

// Short-lived cache: normalizedId -> normalizedParentId (or null if no parent).
// Bounded at 500 entries and evicted in insertion order (FIFO, not LRU: cacheGet
// does not refresh recency); entries expire after 60s.
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  parentId: string | null;
  ts: number;
}

const parentCache = new Map<string, CacheEntry>();

/** Clears the parent cache. Exported for test use. */
export function clearParentCache(): void {
  parentCache.clear();
}

function cacheGet(normalizedId: string): string | null | undefined {
  const entry = parentCache.get(normalizedId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    parentCache.delete(normalizedId);
    return undefined;
  }
  return entry.parentId;
}

function cacheSet(normalizedId: string, parentId: string | null): void {
  if (parentCache.size >= CACHE_MAX) {
    // Evict oldest entry
    const first = parentCache.keys().next().value;
    if (first !== undefined) parentCache.delete(first);
  }
  parentCache.set(normalizedId, { parentId, ts: Date.now() });
}

/**
 * Resolves the immediate parent ID for a page or block, using the cache
 * when available and falling back to the Notion API (page first, then block).
 * Returns the normalized parent ID, or null if there is no parent.
 */
export async function resolveParentId(pageId: string): Promise<string | null> {
  // Cache key is normalized; the raw pageId goes to the API since Notion
  // accepts both dashed and undashed UUIDs.
  const nid = normalizeId(pageId);
  const cached = cacheGet(nid);
  if (cached !== undefined) return cached;

  let item: NotionRetrieveResponse;
  try {
    try {
      item = await notionRequest<NotionRetrieveResponse>(`/pages/${pageId}`);
    } catch {
      item = await notionRequest<NotionRetrieveResponse>(`/blocks/${pageId}`);
    }
  } catch {
    // Deliberately not cached: a transient transport error must not become a 60s
    // "no parent" verdict, which every caller reads as a denial.
    return null;
  }

  const parent = item?.parent;
  if (!parent) {
    cacheSet(nid, null);
    return null;
  }

  const parentId = parent.page_id || parent.database_id || parent.block_id;
  const result = parentId ? normalizeId(parentId) : null;
  cacheSet(nid, result);
  return result;
}

/**
 * Walks the parent chain looking for an ancestor in `targetSet`.
 * Stops early if an excluded ancestor is found. Returns the matched
 * normalized ID, or null if none matched within MAX_ANCESTRY_DEPTH hops.
 */
export async function findAncestorInSet(
  startId: string,
  targetSet: Set<string>,
  excludedSet: Set<string>,
  deadlineMs: number = ANCESTRY_DEADLINE_MS
): Promise<string | null> {
  const deadline = Date.now() + deadlineMs;
  let currentId = normalizeId(startId);
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (Date.now() > deadline) {
      debugWarn('ancestry walk exceeded wall-clock deadline', {
        startId: normalizeId(startId),
        depth,
        deadlineMs,
      });
      return null;
    }
    const parentId = await resolveParentId(currentId);
    if (!parentId) return null;
    if (excludedSet.has(parentId)) return null;
    if (targetSet.has(parentId)) return parentId;
    currentId = parentId;
  }
  debugWarn('ancestry walk exhausted without a match', { startId: normalizeId(startId), depth: MAX_ANCESTRY_DEPTH });
  return null;
}

/** Pre-builds a normalized Set of allowed page IDs for O(1) lookups. */
export function buildAllowedIdSet(allowedPages: AllowedPageEntry[]): Set<string> {
  return new Set(allowedPages.map(p => normalizeId(p.id)));
}

/** Finds an AllowedPageEntry by normalized ID. */
export function findAllowedPage(pageId: string, allowedPages: AllowedPageEntry[]): AllowedPageEntry | null {
  const normalized = normalizeId(pageId);
  return allowedPages.find(p => normalizeId(p.id) === normalized) ?? null;
}

/**
 * Checks whether `targetId` is a descendant of `rootPageId` (or is the root
 * itself) by walking the parent chain.
 */
export async function isDescendantOfRoot(targetId: string, rootPageId: string): Promise<boolean> {
  const normalizedRoot = normalizeId(rootPageId);
  if (normalizeId(targetId) === normalizedRoot) return true;

  const emptyExcluded = new Set<string>();
  const rootSet = new Set([normalizedRoot]);
  const match = await findAncestorInSet(targetId, rootSet, emptyExcluded);
  return match !== null;
}
