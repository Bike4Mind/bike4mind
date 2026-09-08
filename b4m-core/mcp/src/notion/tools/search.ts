/**
 * Notion MCP Server - Search Tools
 *
 * Tools for searching pages and databases in Notion.
 * When accessMode is 'selected', results are filtered to only include
 * pages within the allowed page scopes.
 */

import { z } from 'zod';
import type { McpServer, NotionSearchResponse, NotionSearchResult, NotionProperty, NotionRichText } from '../types.js';
import { notionRequest } from '../client.js';
import { getConfig } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { searchFilterTypeSchema, paginationParams } from '../helpers/schemas.js';
import { normalizeId, buildAllowedIdSet, findAncestorInSet, MAX_ANCESTRY_CONCURRENCY } from '../helpers/ancestry.js';
import { TOOL_NOTION_SEARCH, TOOL_DESCRIPTIONS } from '../constants.js';
import { debug } from '../logger.js';

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

  if (normalizedExcluded.has(normalized)) return false;
  if (allowedIdSet.has(normalized)) return true;

  if (parent) {
    const parentId = parent.page_id || parent.database_id || parent.block_id;
    if (parentId) {
      if (normalizedExcluded.has(normalizeId(parentId))) return false;
      if (allowedIdSet.has(normalizeId(parentId))) return true;
    }
  }

  return null;
}

export function registerSearchTools(server: McpServer): void {
  server.tool(
    TOOL_NOTION_SEARCH,
    TOOL_DESCRIPTIONS[TOOL_NOTION_SEARCH],
    {
      query: z.string().min(1).max(200).describe('Text to search for in the connected Notion workspace'),
      ...paginationParams,
      filterType: searchFilterTypeSchema.optional(),
    },
    async ({ query, page_size, start_cursor, filterType }) => {
      try {
        debug('search invoked', { query, page_size, start_cursor, filterType });
        const config = getConfig();
        const requestedSize = page_size ?? 10;

        // In 'selected' mode, fetch more results to compensate for filtering
        const fetchSize = config.accessMode === 'selected' ? Math.min(requestedSize * 3, 100) : requestedSize;

        const body: Record<string, unknown> = {
          query,
          page_size: fetchSize,
        };

        if (start_cursor) {
          body.start_cursor = start_cursor;
        }

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

        debug(`search returned ${(result.results || []).length} raw results`);
        let items = (result.results || []).map(item => ({
          object: item.object,
          id: item.id,
          url: item.url,
          title: extractTitle(item),
          parent: item.parent,
        }));

        // Filter results when access mode is 'selected'
        if (config.accessMode === 'selected') {
          if (config.allowedPages.length === 0) {
            return createSuccessResponse({ query, count: 0, results: [] });
          }

          const allowedIdSet = buildAllowedIdSet(config.allowedPages);
          const normalizedExcluded = new Set(config.excludedPageIds.map(normalizeId));

          debug('access mode is "selected", filtering results', {
            allowedPages: config.allowedPages.length,
            excludedPageIds: config.excludedPageIds.length,
          });

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
              chunk.map(idx => {
                const match = findAncestorInSet(items[idx].id, allowedIdSet, normalizedExcluded);
                return match.then(m => m !== null);
              })
            );
            for (let j = 0; j < chunk.length; j++) {
              resolved[chunk[j]] = results[j];
            }
          }

          const preFilterCount = items.length;
          items = items.filter((_, idx) => resolved[idx]);
          items = items.slice(0, requestedSize);
          debug('filtering complete', {
            preFilter: preFilterCount,
            postFilter: items.length,
            ancestryWalks: needsAncestryWalk.length,
          });
        }

        debug('search complete', { query, resultCount: items.length });
        return createSuccessResponse({
          query,
          count: items.length,
          has_more: result.has_more ?? false,
          next_cursor: result.next_cursor ?? null,
          results: items,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}
