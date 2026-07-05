import { baseApi } from '@server/middlewares/baseApi';
import { NotionTokenManager } from '@server/integrations/notion/notionTokenManager';
import { NOTION_API_BASE_URL } from '@server/integrations/notion/notionConfig';

interface NotionSearchResult {
  object: string;
  id: string;
  url?: string;
  parent?: {
    type: string;
    workspace?: boolean;
    page_id?: string;
    database_id?: string;
  };
  properties?: Record<
    string,
    {
      type: string;
      title?: Array<{ plain_text: string }>;
    }
  >;
  has_children?: boolean;
}

const NOTION_UUID_REGEX = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  child_page?: { title: string };
  child_database?: { title: string };
}

interface PageNode {
  id: string;
  title: string;
  type: 'page' | 'database';
  hasChildren: boolean;
}

function extractTitle(result: NotionSearchResult): string {
  if (!result.properties) return 'Untitled';
  for (const value of Object.values(result.properties)) {
    if (value.type !== 'title' || !Array.isArray(value.title)) continue;
    const title = value.title
      .map(item => item.plain_text || '')
      .join('')
      .trim();
    if (title) return title;
  }
  return 'Untitled';
}

/**
 * Browse Notion workspace pages for the permission picker.
 *
 * GET /api/mcp-servers/notion/pages
 *   - No params: returns top-level pages (parent is workspace)
 *
 * GET /api/mcp-servers/notion/pages?parentId=<pageId>
 *   - Returns child pages/databases of the given page
 */
const handler = baseApi().get(async (req, res) => {
  try {
    const userId = req.user.id;
    const parentId = req.query.parentId as string | undefined;

    if (parentId && !NOTION_UUID_REGEX.test(parentId)) {
      return res.status(400).json({ error: 'Invalid parent page ID format. Must be a Notion UUID.' });
    }

    const accessToken = await NotionTokenManager.ensureValidToken(userId);

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    let pages: PageNode[];

    if (parentId) {
      pages = await fetchChildPages(parentId, headers);
    } else {
      pages = await fetchTopLevelPages(headers);
    }

    res.status(200).json({ pages });
  } catch (error) {
    console.error('[Notion Pages] Error browsing pages:', error);
    const message = error instanceof Error ? error.message : 'Failed to browse Notion pages';
    res.status(500).json({ error: message });
  }
});

async function fetchTopLevelPages(headers: Record<string, string>): Promise<PageNode[]> {
  const allPages: PageNode[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  // Paginate through search results to find workspace-level pages
  while (hasMore) {
    const body: Record<string, unknown> = {
      page_size: 100,
      sort: { direction: 'ascending', timestamp: 'last_edited_time' },
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = await fetch(`${NOTION_API_BASE_URL}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Notion search failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      results: NotionSearchResult[];
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const result of data.results) {
      if (result.parent?.type === 'workspace') {
        allPages.push({
          id: result.id,
          title: extractTitle(result),
          type: result.object === 'database' ? 'database' : 'page',
          hasChildren: true, // Workspace-level items likely have children
        });
      }
    }

    hasMore = data.has_more;
    startCursor = data.next_cursor ?? undefined;
  }

  return allPages;
}

async function fetchChildPages(parentId: string, headers: Record<string, string>): Promise<PageNode[]> {
  const pages: PageNode[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const url = startCursor
      ? `${NOTION_API_BASE_URL}/blocks/${parentId}/children?page_size=100&start_cursor=${startCursor}`
      : `${NOTION_API_BASE_URL}/blocks/${parentId}/children?page_size=100`;

    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      throw new Error(`Notion blocks fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const block of data.results) {
      if (block.type === 'child_page') {
        pages.push({
          id: block.id,
          title: block.child_page?.title ?? 'Untitled',
          type: 'page',
          hasChildren: block.has_children,
        });
      } else if (block.type === 'child_database') {
        pages.push({
          id: block.id,
          title: block.child_database?.title ?? 'Untitled',
          type: 'database',
          hasChildren: false,
        });
      }
    }

    hasMore = data.has_more;
    startCursor = data.next_cursor ?? undefined;
  }

  return pages;
}

export default handler;
