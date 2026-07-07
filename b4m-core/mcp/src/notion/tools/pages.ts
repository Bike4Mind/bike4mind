/**
 * Notion MCP Server - Page Tools
 *
 * Tools for creating and managing Notion pages,
 * and appending block content to existing pages.
 *
 * Write operations (create_page, append_blocks) are gated by:
 * - NOTION_WRITE_ENABLED env var (must be "true")
 * - NOTION_ROOT_PAGE_ID env var (all writes scoped to this page tree via ancestry validation)
 */

import { z } from 'zod';
import type {
  McpServer,
  NotionBlock,
  NotionBlockChildrenResponse,
  NotionPageParent,
  NotionPageResponse,
  NotionAppendBlocksResponse,
  NotionRetrieveResponse,
  NotionRichTextWithHref,
} from '../types.js';
import { notionRequest } from '../client.js';
import { getConfig, type AllowedPageEntry } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../helpers/responses.js';
import { notionPageIdSchema, notionDatabaseIdSchema, startCursorSchema } from '../helpers/schemas.js';
import { TOOL_NOTION_CREATE_PAGE, TOOL_NOTION_APPEND_BLOCKS, TOOL_NOTION_READ_PAGE } from '../constants.js';
import { debug, debugWarn } from '../logger.js';

/**
 * Guards write operations. Returns an error response if writes are disabled
 * or no root page is configured.
 */
function checkWriteAccess(): ReturnType<typeof createErrorResponse> | null {
  const config = getConfig();

  if (!config.writeEnabled) {
    debugWarn('write access denied: writeEnabled is false');
    return createErrorResponse(
      new Error(
        'Notion write access is disabled. Enable it in your integration settings (Profile > Integrations > Notion).'
      )
    );
  }

  if (!config.rootPageId) {
    debugWarn('write access denied: no rootPageId configured');
    return createErrorResponse(
      new Error(
        'No Notion root page configured. Set a root page ID in your integration settings to scope where content is created.'
      )
    );
  }

  return null;
}

/**
 * Checks whether a page is accessible under the page-level access control system.
 * Returns null if access is granted, or an error response if denied.
 *
 * @param pageId - The page/block to check access for
 * @param requiredAccess - 'read' or 'readwrite'
 */
async function checkPageAccess(
  pageId: string,
  requiredAccess: 'read' | 'readwrite'
): Promise<ReturnType<typeof createErrorResponse> | null> {
  debug(`checkPageAccess: pageId=${pageId}, requiredAccess=${requiredAccess}`);
  const config = getConfig();

  // Legacy mode - no page-level restrictions
  if (config.accessMode !== 'selected') {
    debug('checkPageAccess: accessMode is "all", granting access');
    return null;
  }

  if (config.allowedPages.length === 0) {
    return createErrorResponse(
      new Error('No pages are configured for access. Add pages in your Notion integration settings.')
    );
  }

  // Check if the page is explicitly excluded
  const normalizedExcluded = new Set(config.excludedPageIds.map(normalizeId));
  if (normalizedExcluded.has(normalizeId(pageId))) {
    return createErrorResponse(new Error(`Access denied: page ${pageId} has been explicitly excluded from access.`));
  }

  // Check if page is directly in the allowed list
  const directMatch = findAllowedPage(pageId, config.allowedPages);
  if (directMatch) {
    if (requiredAccess === 'readwrite' && directMatch.access !== 'readwrite') {
      return createErrorResponse(new Error(`Write access denied for page ${pageId}. It is configured as read-only.`));
    }
    return null;
  }

  // Walk ancestry to check if any ancestor is in the allowed list
  debug(`checkPageAccess: walking ancestry for pageId=${pageId}`);
  const ancestorResult = await findAllowedAncestor(pageId, config.allowedPages, config.excludedPageIds);
  if (ancestorResult) {
    debug(`checkPageAccess: ancestor match found`, { ancestorId: ancestorResult.id, access: ancestorResult.access });
    if (requiredAccess === 'readwrite' && ancestorResult.access !== 'readwrite') {
      return createErrorResponse(
        new Error(`Write access denied for page ${pageId}. Its parent scope is configured as read-only.`)
      );
    }
    return null;
  }

  return createErrorResponse(
    new Error(
      `Access denied: page ${pageId} is not within any allowed page scope. ` +
        'Configure page access in your Notion integration settings.'
    )
  );
}

/**
 * Finds a direct match in the allowed pages list.
 */
function findAllowedPage(pageId: string, allowedPages: AllowedPageEntry[]): AllowedPageEntry | null {
  const normalized = normalizeId(pageId);
  return allowedPages.find(p => normalizeId(p.id) === normalized) ?? null;
}

/**
 * Walks the parent chain to find if any ancestor is in the allowed pages list.
 * Returns the matching allowed page entry, or null if none found.
 * Respects excluded page IDs - if an ancestor is excluded, stops walking.
 */
async function findAllowedAncestor(
  targetId: string,
  allowedPages: AllowedPageEntry[],
  excludedPageIds: string[]
): Promise<AllowedPageEntry | null> {
  const normalizedExcluded = new Set(excludedPageIds.map(normalizeId));

  let currentId = targetId;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    let item: NotionRetrieveResponse;
    try {
      try {
        item = await notionRequest<NotionRetrieveResponse>(`/pages/${currentId}`);
      } catch {
        item = await notionRequest<NotionRetrieveResponse>(`/blocks/${currentId}`);
      }
    } catch {
      return null;
    }

    const parent = item.parent;
    if (!parent) return null;

    const parentId = parent.page_id || parent.database_id || parent.block_id;
    if (!parentId) return null;

    // If parent is explicitly excluded, deny
    if (normalizedExcluded.has(normalizeId(parentId))) {
      return null;
    }

    // Check if parent is in allowed list
    const match = findAllowedPage(parentId, allowedPages);
    if (match) return match;

    currentId = parentId;
  }

  return null;
}

/** Max parent hops when validating ancestry to prevent infinite loops. */
const MAX_ANCESTRY_DEPTH = 10;

/**
 * Normalizes a Notion UUID by removing dashes for comparison.
 */
function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/**
 * Validates that a target page/block is a descendant of rootPageId by walking
 * the parent chain via the Notion API. Returns true if the target IS the root
 * page or is nested under it.
 */
async function isDescendantOfRoot(targetId: string, rootPageId: string): Promise<boolean> {
  const normalizedRoot = normalizeId(rootPageId);

  // If target is the root page itself, allow it
  if (normalizeId(targetId) === normalizedRoot) {
    return true;
  }

  debug(`isDescendantOfRoot: checking targetId=${targetId} against rootPageId=${rootPageId}`);
  let currentId = targetId;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    let item: NotionRetrieveResponse;
    try {
      // Try as a page first, then as a block
      try {
        item = await notionRequest<NotionRetrieveResponse>(`/pages/${currentId}`);
      } catch {
        item = await notionRequest<NotionRetrieveResponse>(`/blocks/${currentId}`);
      }
    } catch {
      // Can't retrieve - not accessible or doesn't exist
      debug(`isDescendantOfRoot: failed to retrieve ${currentId} at depth ${depth}`);
      return false;
    }

    const parent = item.parent;
    if (!parent) {
      debug(`isDescendantOfRoot: no parent on ${currentId} at depth ${depth}`);
      return false;
    }

    const parentId = parent.page_id || parent.database_id || parent.block_id;
    if (!parentId) {
      // Reached workspace root without finding rootPageId
      debug(`isDescendantOfRoot: reached workspace root at depth ${depth}`);
      return false;
    }

    debug(`isDescendantOfRoot: depth ${depth}, parentId=${parentId}`);
    if (normalizeId(parentId) === normalizedRoot) {
      debug(`isDescendantOfRoot: match found at depth ${depth}`);
      return true;
    }

    currentId = parentId;
  }

  // Exceeded max depth
  debugWarn(`isDescendantOfRoot: exceeded max ancestry depth (${MAX_ANCESTRY_DEPTH})`);
  return false;
}

/**
 * Supported block types for the append_blocks tool.
 */
const BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
  'divider',
] as const;

type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * Zod schema for a simplified block input.
 */
const blockSchema = z.object({
  type: z.enum(BLOCK_TYPES).describe('The block type'),
  text: z.string().max(2000).optional().describe('Text content for the block. Not needed for divider.'),
  checked: z.boolean().optional().describe('Whether the to-do is checked. Only used for to_do blocks.'),
  language: z.string().max(50).optional().describe('Programming language for code blocks. Defaults to "plain text".'),
});

type BlockInput = z.infer<typeof blockSchema>;

/**
 * Build a rich_text array from a plain text string.
 */
function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  return [{ type: 'text', text: { content: text } }];
}

/**
 * Convert a simplified block input to a Notion API block object.
 */
function toNotionBlock(block: BlockInput): Record<string, unknown> {
  const type = block.type as BlockType;

  if (type === 'divider') {
    return { object: 'block', type: 'divider', divider: {} };
  }

  const text = block.text ?? '';

  switch (type) {
    case 'paragraph':
      return { object: 'block', type, paragraph: { rich_text: richText(text) } };
    case 'heading_1':
      return { object: 'block', type, heading_1: { rich_text: richText(text) } };
    case 'heading_2':
      return { object: 'block', type, heading_2: { rich_text: richText(text) } };
    case 'heading_3':
      return { object: 'block', type, heading_3: { rich_text: richText(text) } };
    case 'bulleted_list_item':
      return { object: 'block', type, bulleted_list_item: { rich_text: richText(text) } };
    case 'numbered_list_item':
      return { object: 'block', type, numbered_list_item: { rich_text: richText(text) } };
    case 'to_do':
      return {
        object: 'block',
        type,
        to_do: { rich_text: richText(text), checked: block.checked ?? false },
      };
    case 'toggle':
      return { object: 'block', type, toggle: { rich_text: richText(text) } };
    case 'quote':
      return { object: 'block', type, quote: { rich_text: richText(text) } };
    case 'callout':
      return { object: 'block', type, callout: { rich_text: richText(text) } };
    case 'code':
      return {
        object: 'block',
        type,
        code: { rich_text: richText(text), language: block.language ?? 'plain text' },
      };
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported block type: ${_exhaustive}`);
    }
  }
}

const BLOCK_TYPES_WITH_RICH_TEXT = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
  'template',
]);

function extractPlainText(readRichText: NotionRichTextWithHref[] | undefined): string {
  if (!Array.isArray(readRichText)) {
    return '';
  }

  return readRichText
    .map(item => item.plain_text || '')
    .join('')
    .trim();
}

function summarizeBlock(block: NotionBlock): Record<string, unknown> {
  const blockData = block[block.type];
  const typedBlockData =
    typeof blockData === 'object' && blockData !== null ? (blockData as Record<string, unknown>) : {};
  const summary: Record<string, unknown> = {
    id: block.id,
    type: block.type,
    has_children: block.has_children ?? false,
  };

  if (BLOCK_TYPES_WITH_RICH_TEXT.has(block.type)) {
    const rt = typedBlockData.rich_text as NotionRichTextWithHref[] | undefined;
    summary.text = extractPlainText(rt);
  }

  if (block.type === 'to_do' && typeof typedBlockData.checked === 'boolean') {
    summary.checked = typedBlockData.checked;
  }

  if (block.type === 'child_page' && typeof typedBlockData.title === 'string') {
    summary.title = typedBlockData.title;
  }

  if (block.type === 'child_database' && typeof typedBlockData.title === 'string') {
    summary.title = typedBlockData.title;
  }

  if (block.type === 'bookmark' && typeof typedBlockData.url === 'string') {
    summary.url = typedBlockData.url;
  }

  if (block.type === 'embed' && typeof typedBlockData.url === 'string') {
    summary.url = typedBlockData.url;
  }

  if (block.type === 'link_preview' && typeof typedBlockData.url === 'string') {
    summary.url = typedBlockData.url;
  }

  if (block.type === 'equation' && typeof typedBlockData.expression === 'string') {
    summary.expression = typedBlockData.expression;
  }

  return summary;
}

export function registerPageTools(server: McpServer): void {
  // --- Create Page ---
  server.tool(
    TOOL_NOTION_CREATE_PAGE,
    {
      title: z.string().min(1).max(200).describe('Title of the Notion page to create'),
      content: z
        .string()
        .max(2000)
        .optional()
        .describe('Optional plain text content to insert as the first paragraph of the new page'),
      parentPageId: notionPageIdSchema
        .optional()
        .describe(
          'Optional parent page ID (UUID). Must be within the configured root page tree. If omitted, defaults to root page.'
        ),
      parentDatabaseId: notionDatabaseIdSchema
        .optional()
        .describe('Optional parent database ID (UUID). If provided, the page is created as a database row/page.'),
    },
    async ({ title, content, parentPageId, parentDatabaseId }) => {
      try {
        debug('create_page invoked', { title, hasContent: !!content, parentPageId, parentDatabaseId });
        // Gate write access (legacy toggle + root page)
        const writeError = checkWriteAccess();
        if (writeError) return writeError;

        const config = getConfig();
        const rootPageId = config.rootPageId!;

        // Page-level access control - check write permission on the target parent
        const targetParent = parentPageId || rootPageId;
        const pageAccessError = await checkPageAccess(targetParent, 'readwrite');
        if (pageAccessError) return pageAccessError;

        // Validate explicit parentPageId is within root page tree (skip if database parent takes priority)
        if (parentPageId && !parentDatabaseId) {
          const allowed = await isDescendantOfRoot(parentPageId, rootPageId);
          if (!allowed) {
            return createErrorResponse(
              new Error(
                `Parent page ${parentPageId} is not within the configured root page tree. ` +
                  'Content can only be created under the designated Notion root page.'
              )
            );
          }
        }

        // Determine parent: database > explicit page > root page (never workspace-level)
        const parent: NotionPageParent = parentDatabaseId
          ? { database_id: parentDatabaseId }
          : { page_id: parentPageId || rootPageId };

        const body: Record<string, unknown> = {
          parent,
          properties: {
            title: {
              title: [
                {
                  text: {
                    content: title,
                  },
                },
              ],
            },
          },
        };

        if (content) {
          body.children = [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content,
                    },
                  },
                ],
              },
            },
          ];
        }

        const result = await notionRequest<NotionPageResponse>('/pages', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        return createSuccessResponse({
          id: result.id,
          url: result.url,
          title,
          parent,
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // --- Append Blocks ---
  server.tool(
    TOOL_NOTION_APPEND_BLOCKS,
    {
      blockId: notionPageIdSchema.describe('The ID of the page or block to append children to (UUID format).'),
      blocks: z
        .array(blockSchema)
        .min(1)
        .max(100)
        .describe(
          'Array of blocks to append (1-100). Each block has a type and text content. ' +
            'Supported types: paragraph, heading_1, heading_2, heading_3, ' +
            'bulleted_list_item, numbered_list_item, to_do, toggle, quote, callout, code, divider.'
        ),
    },
    async ({ blockId, blocks }) => {
      try {
        debug('append_blocks invoked', { blockId, blockCount: blocks.length });
        // Gate write access (legacy toggle + root page)
        const writeError = checkWriteAccess();
        if (writeError) return writeError;

        const config = getConfig();

        // Page-level access control
        const pageAccessError = await checkPageAccess(blockId, 'readwrite');
        if (pageAccessError) return pageAccessError;

        // Validate target is within root page tree
        const allowed = await isDescendantOfRoot(blockId, config.rootPageId!);
        if (!allowed) {
          return createErrorResponse(
            new Error(
              `Target ${blockId} is not within the configured root page tree. ` +
                'Content can only be appended to pages under the designated Notion root page.'
            )
          );
        }

        const children = blocks.map(toNotionBlock);

        const result = await notionRequest<NotionAppendBlocksResponse>(`/blocks/${blockId}/children`, {
          method: 'PATCH',
          body: JSON.stringify({ children }),
        });

        return createSuccessResponse({
          blockId,
          appended: result.results.length,
          blockIds: result.results.map(b => b.id),
        });
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );

  // --- Read Page ---
  server.tool(
    TOOL_NOTION_READ_PAGE,
    {
      pageId: notionPageIdSchema.describe('Notion page ID to read content from'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of child blocks to return (1-100, default 100)'),
      start_cursor: startCursorSchema,
    },
    async ({ pageId, page_size, start_cursor }) => {
      try {
        debug('read_page invoked', { pageId, page_size, start_cursor });
        // Page-level access control
        const pageAccessError = await checkPageAccess(pageId, 'read');
        if (pageAccessError) return pageAccessError;

        const params = new URLSearchParams();
        params.set('page_size', String(page_size ?? 100));
        if (start_cursor) {
          params.set('start_cursor', start_cursor);
        }

        const result = await notionRequest<NotionBlockChildrenResponse>(
          `/blocks/${pageId}/children?${params.toString()}`,
          {
            method: 'GET',
          }
        );

        const blocks = (result.results || []).map(summarizeBlock);
        const plainText = blocks
          .map(block => {
            if (typeof block.text === 'string' && block.text.length > 0) {
              return block.text;
            }
            if (typeof block.title === 'string' && block.title.length > 0) {
              return block.title;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');

        return createSuccessResponse({
          pageId,
          count: blocks.length,
          has_more: result.has_more ?? false,
          next_cursor: result.next_cursor ?? null,
          blocks,
          plain_text: plainText,
        });
      } catch (error) {
        return createErrorResponse(error, { pageId });
      }
    }
  );
}
