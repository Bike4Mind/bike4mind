/**
 * Notion MCP Server - Configuration
 *
 * Environment variable parsing with lazy-loading.
 * Reinitializes when env vars change at runtime (MCP host can update them).
 */

import { debug } from './logger.js';

export interface AllowedPageEntry {
  id: string;
  access: 'read' | 'readwrite';
}

interface NotionConfig {
  accessToken: string;
  writeEnabled: boolean;
  rootPageId: string | null;
  accessMode: 'all' | 'selected';
  allowedPages: AllowedPageEntry[];
  excludedPageIds: string[];
}

let cachedConfig: NotionConfig | null = null;
let envSignature: string | null = null;

export function getEnvSignature(): string {
  return JSON.stringify({
    accessToken: process.env.NOTION_ACCESS_TOKEN ?? '',
    writeEnabled: process.env.NOTION_WRITE_ENABLED ?? '',
    rootPageId: process.env.NOTION_ROOT_PAGE_ID ?? '',
    accessMode: process.env.NOTION_ACCESS_MODE ?? '',
    allowedPages: process.env.NOTION_ALLOWED_PAGES ?? '',
    excludedPageIds: process.env.NOTION_EXCLUDED_PAGE_IDS ?? '',
  });
}

export function getConfig(): NotionConfig {
  const signature = getEnvSignature();

  if (!cachedConfig || envSignature !== signature) {
    const accessToken = process.env.NOTION_ACCESS_TOKEN;

    if (!accessToken) {
      throw new Error('Notion configuration error: NOTION_ACCESS_TOKEN is required. Please ensure it is set.');
    }

    let allowedPages: AllowedPageEntry[] = [];
    const allowedPagesRaw = process.env.NOTION_ALLOWED_PAGES;
    if (allowedPagesRaw) {
      try {
        const parsed = JSON.parse(allowedPagesRaw);
        if (!Array.isArray(parsed)) {
          throw new Error('NOTION_ALLOWED_PAGES must be a JSON array');
        }
        allowedPages = parsed as AllowedPageEntry[];
      } catch (err) {
        throw new Error(
          `Invalid NOTION_ALLOWED_PAGES configuration: ${err instanceof Error ? err.message : 'parse failed'}. ` +
            'Check your Notion integration settings.'
        );
      }
    }

    const excludedRaw = process.env.NOTION_EXCLUDED_PAGE_IDS;
    const excludedPageIds = excludedRaw ? excludedRaw.split(',').filter(Boolean) : [];

    cachedConfig = {
      accessToken,
      writeEnabled: process.env.NOTION_WRITE_ENABLED === 'true',
      rootPageId: process.env.NOTION_ROOT_PAGE_ID || null,
      accessMode: (process.env.NOTION_ACCESS_MODE as 'all' | 'selected') || 'all',
      allowedPages,
      excludedPageIds,
    };
    envSignature = signature;
    debug('config initialized', {
      writeEnabled: cachedConfig.writeEnabled,
      rootPageId: cachedConfig.rootPageId ? '[set]' : null,
      accessMode: cachedConfig.accessMode,
      allowedPages: cachedConfig.allowedPages.length,
      excludedPageIds: cachedConfig.excludedPageIds.length,
    });
  }

  return cachedConfig;
}
