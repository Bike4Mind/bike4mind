import { baseApi } from '@server/middlewares/baseApi';
import { mcpServerRepository, userRepository } from '@bike4mind/database';
import { McpServerName } from '@bike4mind/common';
import { NotionTokenManager } from '@server/integrations/notion/notionTokenManager';
import { decryptToken, decryptEnvVariables, encryptEnvVariables } from '@server/security/tokenEncryption';

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
    } else {
      // Token decryption failed (e.g. key rotation) but the MCP server may still
      // have working env vars. Patch the settings-related env vars in place.
      console.warn('[Notion Settings] Token decryption failed, using fallback env var patch');
      try {
        await patchMcpServerEnvVars(userId, {
          writeEnabled: typeof writeEnabled === 'boolean' ? writeEnabled : user.notionConnect.writeEnabled,
          rootPageId: rootPageId !== undefined ? rootPageId : (user.notionConnect.rootPageId ?? null),
          accessMode: accessMode ?? user.notionConnect.accessMode ?? 'all',
          allowedPages: allowedPages ?? user.notionConnect.allowedPages ?? [],
          excludedPageIds: excludedPageIds ?? user.notionConnect.excludedPageIds ?? [],
        });
      } catch (patchError) {
        console.warn('[Notion Settings] Fallback MCP env patch failed:', patchError);
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Notion Settings] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update Notion settings' });
  }
});

/**
 * Patches settings-related env vars on an existing Notion MCP server without
 * needing the raw access token. Used when the User model's encrypted token
 * can't be decrypted but the MCP server's own env vars are still valid.
 */
async function patchMcpServerEnvVars(
  userId: string,
  settings: {
    writeEnabled?: boolean;
    rootPageId: string | null;
    accessMode: 'all' | 'selected';
    allowedPages: AllowedPage[];
    excludedPageIds: string[];
  }
) {
  const notionServer = await mcpServerRepository.findOne({
    name: McpServerName.Notion,
    userId,
  });

  if (!notionServer?.envVariables?.length) {
    console.warn('[Notion Settings] No existing MCP server to patch');
    return;
  }

  const envVars = decryptEnvVariables(notionServer.envVariables);
  const envMap = new Map(envVars.map(v => [v.key, v.value]));

  envMap.set('NOTION_WRITE_ENABLED', settings.writeEnabled ? 'true' : 'false');

  if (settings.rootPageId) {
    envMap.set('NOTION_ROOT_PAGE_ID', settings.rootPageId);
  } else {
    envMap.delete('NOTION_ROOT_PAGE_ID');
  }

  envMap.set('NOTION_ACCESS_MODE', settings.accessMode);

  if (settings.accessMode === 'selected' && settings.allowedPages.length > 0) {
    const compactPages = settings.allowedPages.map(p => ({ id: p.id, access: p.access }));
    envMap.set('NOTION_ALLOWED_PAGES', JSON.stringify(compactPages));
  } else {
    envMap.delete('NOTION_ALLOWED_PAGES');
  }

  if (settings.excludedPageIds.length > 0) {
    envMap.set('NOTION_EXCLUDED_PAGE_IDS', settings.excludedPageIds.join(','));
  } else {
    envMap.delete('NOTION_EXCLUDED_PAGE_IDS');
  }

  const updatedVars = Array.from(envMap, ([key, value]) => ({ key, value }));

  await mcpServerRepository.update({
    id: notionServer.id,
    envVariables: encryptEnvVariables(updatedVars),
  });

  console.log('[Notion Settings] Patched MCP server env vars via fallback path');
}

export default handler;
