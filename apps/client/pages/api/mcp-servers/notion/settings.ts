import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { NotionTokenManager } from '@server/integrations/notion/notionTokenManager';
import { decryptToken } from '@server/security/tokenEncryption';

const NOTION_UUID_REGEX = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MAX_ALLOWED_PAGES = 50;
const MAX_EXCLUDED_PAGES = 50;

interface AllowedPage {
  id: string;
  title: string;
  type: 'page' | 'database';
  access: 'read' | 'readwrite';
}

/**
 * Updates Notion integration settings for the current user.
 *
 * PATCH /api/mcp-servers/notion/settings
 *
 * Body: {
 *   writeEnabled?: boolean,
 *   rootPageId?: string | null,
 *   accessMode?: 'all' | 'selected',
 *   allowedPages?: AllowedPage[],
 *   excludedPageIds?: string[],
 * }
 */
const handler = baseApi().patch(async (req, res) => {
  try {
    const userId = req.user.id;
    const { writeEnabled, rootPageId, accessMode, allowedPages, excludedPageIds } = req.body as {
      writeEnabled?: boolean;
      rootPageId?: string | null;
      accessMode?: 'all' | 'selected';
      allowedPages?: AllowedPage[];
      excludedPageIds?: string[];
    };

    if (rootPageId && !NOTION_UUID_REGEX.test(rootPageId)) {
      return res.status(400).json({ error: 'Invalid root page ID format. Must be a Notion UUID.' });
    }

    if (accessMode !== undefined && accessMode !== 'all' && accessMode !== 'selected') {
      return res.status(400).json({ error: 'accessMode must be "all" or "selected"' });
    }

    if (allowedPages !== undefined) {
      if (!Array.isArray(allowedPages)) {
        return res.status(400).json({ error: 'allowedPages must be an array' });
      }
      if (allowedPages.length > MAX_ALLOWED_PAGES) {
        return res.status(400).json({ error: `allowedPages exceeds maximum of ${MAX_ALLOWED_PAGES} entries` });
      }
      for (const page of allowedPages) {
        if (!page.id || !NOTION_UUID_REGEX.test(page.id)) {
          return res.status(400).json({ error: `Invalid page ID format: ${page.id}` });
        }
        if (!['page', 'database'].includes(page.type)) {
          return res.status(400).json({ error: `Invalid page type: ${page.type}` });
        }
        if (!['read', 'readwrite'].includes(page.access)) {
          return res.status(400).json({ error: `Invalid access level: ${page.access}` });
        }
      }
    }

    if (excludedPageIds !== undefined) {
      if (!Array.isArray(excludedPageIds)) {
        return res.status(400).json({ error: 'excludedPageIds must be an array' });
      }
      if (excludedPageIds.length > MAX_EXCLUDED_PAGES) {
        return res.status(400).json({ error: `excludedPageIds exceeds maximum of ${MAX_EXCLUDED_PAGES} entries` });
      }
      for (const id of excludedPageIds) {
        if (!NOTION_UUID_REGEX.test(id)) {
          return res.status(400).json({ error: `Invalid excluded page ID format: ${id}` });
        }
      }
    }

    const user = await userRepository.findByIdWithNotionToken(userId);
    if (!user?.notionConnect) {
      return res.status(400).json({ error: 'Notion is not connected' });
    }

    // Build the update - only include fields that were provided
    const update: Record<string, unknown> = {};

    if (typeof writeEnabled === 'boolean') {
      update['notionConnect.writeEnabled'] = writeEnabled;
    }

    if (rootPageId !== undefined) {
      update['notionConnect.rootPageId'] = rootPageId;
    }

    if (accessMode !== undefined) {
      update['notionConnect.accessMode'] = accessMode;
    }

    if (allowedPages !== undefined) {
      update['notionConnect.allowedPages'] = allowedPages;
    }

    if (excludedPageIds !== undefined) {
      update['notionConnect.excludedPageIds'] = excludedPageIds;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    await userRepository.update({ id: userId, ...update });

    // Re-sync MCP server so the new env vars take effect
    const accessToken = decryptToken(user.notionConnect.accessToken);
    if (accessToken) {
      try {
        await NotionTokenManager.syncMcpServer(userId, accessToken, user.notionConnect.workspaceId);
      } catch (syncError) {
        console.warn('[Notion Settings] MCP sync failed after settings update:', syncError);
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Notion Settings] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update Notion settings' });
  }
});

export default handler;
