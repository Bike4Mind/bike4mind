/**
 * Notion MCP Server - API Client
 *
 * Centralized HTTP client for the Notion API.
 * Uses lazy config access so tokens are refreshed if env vars change.
 */

import { getConfig, getEnvSignature } from './config.js';
import { NOTION_API_BASE_URL, NOTION_VERSION } from './constants.js';

let lastEnvSignature: string | null = null;

/**
 * Ensure the client configuration is fresh.
 * Called before each request to detect env var changes.
 */
function ensureFreshConfig(): void {
  const signature = getEnvSignature();
  if (lastEnvSignature !== signature) {
    lastEnvSignature = signature;
  }
}

/**
 * Make an authenticated request to the Notion API.
 */
export async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  ensureFreshConfig();
  const { accessToken } = getConfig();

  const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Parse Notion error JSON if possible to extract code/message
    let notionCode: string | undefined;
    let notionMessage: string | undefined;
    try {
      const parsed = JSON.parse(errorText) as Record<string, unknown>;
      if (typeof parsed.code === 'string') notionCode = parsed.code;
      if (typeof parsed.message === 'string') notionMessage = parsed.message;
    } catch {
      // Not JSON - use raw text below
    }

    const error = new Error(notionMessage || `Notion API error: ${response.status} ${response.statusText}`);
    (error as Error & { status?: number; code?: string }).status = response.status;
    if (notionCode) {
      (error as Error & { code?: string }).code = notionCode;
    }
    throw error;
  }

  return (await response.json()) as T;
}
