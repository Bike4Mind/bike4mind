/**
 * Notion MCP Server - Constants
 *
 * Tool names, API configuration, and other constants.
 */

// API configuration
export const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';

// Search Tools
export const TOOL_NOTION_SEARCH = 'notion_search' as const;

// Page Tools
export const TOOL_NOTION_CREATE_PAGE = 'notion_create_page' as const;
export const TOOL_NOTION_READ_PAGE = 'notion_read_page' as const;

// Block Tools
export const TOOL_NOTION_APPEND_BLOCKS = 'notion_append_blocks' as const;

// Tool categories for organized logging and documentation
export const TOOL_CATEGORIES = {
  Search: [TOOL_NOTION_SEARCH],
  Pages: [TOOL_NOTION_CREATE_PAGE, TOOL_NOTION_READ_PAGE],
  Blocks: [TOOL_NOTION_APPEND_BLOCKS],
} as const;

// All tool names for validation (derived from categories)
export const ALL_TOOL_NAMES = Object.values(TOOL_CATEGORIES).flat();

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

// Tool descriptions - single source of truth referenced by both the MCP server
// registrations and the MCP_PROVIDER_METADATA fallback in @bike4mind/common.
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  [TOOL_NOTION_SEARCH]:
    'Search for pages and databases in the connected Notion workspace by text query. Returns matching page titles, IDs, and URLs.',
  [TOOL_NOTION_CREATE_PAGE]:
    'Create a new page in the connected Notion workspace. Requires write access to be enabled. The page is created under the configured root page or a specified parent.',
  [TOOL_NOTION_READ_PAGE]:
    'Read the content of a Notion page by its ID. Returns the child blocks (text, headings, lists, etc.) and a plain-text summary. Results are paginated; pass start_cursor with the returned next_cursor when has_more is true.',
  [TOOL_NOTION_APPEND_BLOCKS]:
    'Append content blocks (paragraphs, headings, lists, code, etc.) to an existing Notion page or block. Requires write access.',
};
