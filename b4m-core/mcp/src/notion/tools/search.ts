/**
 * Notion MCP Server - Search Tools
 *
 * Tools for searching pages and databases in Notion.
 * When accessMode is 'selected', results are filtered to only include
 * pages within the allowed page scopes.
 */

import { z } from 'zod';
import type {
  McpServer,
  NotionSearchResponse,
  NotionSearchResult,
  NotionProperty,
  NotionRichText,
  NotionRetrieveResponse,
} from '../types.js';
import { notionRequest } from '../client.js';
import { getConfig, type AllowedPageEntry } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { searchFilterTypeSchema, paginationParams } from '../helpers/schemas.js';
import { TOOL_NOTION_SEARCH } from '../constants.js';

/**
 * Extract the title from a Notion search result's properties.
 */
function extractTitle(result: NotionSearchResult): string {
  const properties = result.properties;
  if (!properties) {
    return 'Untitled';
  }

  for (const value of Object.values(properties)) {
    const property = value as NotionProperty;
    if (property.type !== 'title' || !Array.isArray(property.title)) continue;
    const title = property.title
      .map((item: NotionRichText) => item.plain_text || '')
      .join('')
      .trim();
    if (title) {
      return title;
    }
  }

  return 'Untitled';
}

function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

const MAX_ANCESTRY_DEPTH = 10;
const MAX_ANCESTRY_CONCURRENCY = 3;

/**
 * Pre-builds a normalized Set of allowed page IDs for O(1) lookups.
 */
function buildAllowedIdSet(allowedPages: AllowedPageEntry[]): Set<string> {
  return new Set(allowedPages.map(p => normalizeId(p.id)));
}

/**
 * Fast client-side check using the parent field already present on search results.
 * Returns true if the result or its immediate parent is in the allowed set
 * and neither is excluded.
 */
function isAccessibleFromParentField(
  pageId: string,
  parent: { page_id?: string; database_id?: string; block_id?: string } | undefined,
  allowedIdSet: Set<string>,
  normalizedExcluded: Set<string>
): boolean | null {
  const normalized = normalizeId(pageId);

  // Excluded takes precedence
  if (normalizedExcluded.has(normalized)) return false;

  // Direct match in allowed list
  if (allowedIdSet.has(normalized)) return true;

  // Check immediate parent from the search result (no API call needed)
  if (parent) {
    const parentId = parent.page_id || parent.database_id || parent.block_id;
    if (parentId) {
      if (normalizedExcluded.has(normalizeId(parentId))) return false;
      if (allowedIdSet.has(normalizeId(parentId))) return true;
    }
  }

  // Indeterminate - need ancestry walk
  return null;
}

/**
 * Checks if a page is accessible under the page-level access control system
 * by walking the parent chain via API calls.
 * Only called when the fast client-side check is indeterminate.
 */
async function isPageAccessibleViaAncestry(
  pageId: string,
  allowedIdSet: Set<string>,
  normalizedExcluded: Set<string>
): Promise<boolean> {
  let currentId = pageId;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    let item: NotionRetrieveResponse;
    try {
      try {
        item = await notionRequest<NotionRetrieveResponse>(`/pages/${currentId}`);
      } catch {
        item = await notionRequest<NotionRetrieveResponse>(`/blocks/${currentId}`);
      }
    } catch {
      return false;
    }

    if (!item) return false;
    const parent = item.parent;
    if (!parent) return false;

    const parentId = parent.page_id || parent.database_id || parent.block_id;
    if (!parentId) return false;

    if (normalizedExcluded.has(normalizeId(parentId))) return false;
    if (allowedIdSet.has(normalizeId(parentId))) return true;

    currentId = parentId;
  }

  return false;
}

export function registerSearchTools(server: McpServer): void {
  server.tool(
    TOOL_NOTION_SEARCH,
    {
      query: z.string().min(1).max(200).describe('Text to search for in the connected Notion workspace'),
      ...paginationParams,
      filterType: searchFilterTypeSchema.optional(),
    },
    async ({ query, page_size, filterType }) => {
      try {
        const config = getConfig();
        const requestedSize = page_size ?? 10;

        // In 'selected' mode, fetch more results to compensate for filtering
        const fetchSize = config.accessMode === 'selected' ? Math.min(requestedSize * 3, 100) : requestedSize;

        const body: Record<string, unknown> = {
          query,
          page_size: fetchSize,
        };

        if (filterType) {
          body.filter = {
            value: filterType,
            property: 'object',
          };
        }

        const result = await notionRequest<NotionSearchResponse>('/search', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        let items = (result.results || []).map(item => ({
          object: item.object,
          id: item.id,
          url: item.url,
          title: extractTitle(item),
          parent: item.parent,
        }));

        // Filter results when access mode is 'selected'
        if (config.accessMode === 'selected') {
          // Deny-by-default: empty allowed list means nothing is accessible
          if (config.allowedPages.length === 0) {
            return createSuccessResponse({ query, count: 0, results: [] });
          }

          const allowedIdSet = buildAllowedIdSet(config.allowedPages);
          const normalizedExcluded = new Set(config.excludedPageIds.map(normalizeId));

          // Phase 1: Fast client-side filtering using parent field on results
          const resolved: boolean[] = new Array(items.length);
          const needsAncestryWalk: number[] = [];

          for (let i = 0; i < items.length; i++) {
            const fast = isAccessibleFromParentField(items[i].id, items[i].parent, allowedIdSet, normalizedExcluded);
            if (fast !== null) {
              resolved[i] = fast;
            } else {
              needsAncestryWalk.push(i);
            }
          }

          // Phase 2: Concurrency-limited ancestry walks for unresolved items
          for (let batch = 0; batch < needsAncestryWalk.length; batch += MAX_ANCESTRY_CONCURRENCY) {
            const chunk = needsAncestryWalk.slice(batch, batch + MAX_ANCESTRY_CONCURRENCY);
            const results = await Promise.all(
              chunk.map(idx => isPageAccessibleViaAncestry(items[idx].id, allowedIdSet, normalizedExcluded))
            );
            for (let j = 0; j < chunk.length; j++) {
              resolved[chunk[j]] = results[j];
            }
          }

          items = items.filter((_, idx) => resolved[idx]);
          items = items.slice(0, requestedSize);
        }

        return createSuccessResponse({
          query,
          count: items.length,
          results: items,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
