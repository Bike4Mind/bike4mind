/**
 * Notion MCP Server - API Client
 *
 * Centralized HTTP client for the Notion API.
 * Uses lazy config access so tokens are refreshed if env vars change.
 */

import { getConfig } from './config.js';
import { NOTION_API_BASE_URL, NOTION_VERSION } from './constants.js';
import { debug, debugError, debugWarn } from './logger.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0 && seconds <= 60) {
      return seconds * 1000;
    }
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

/**
 * Make an authenticated request to the Notion API.
 * Retries on 429 (rate-limited) and transient 5xx errors.
 */
export async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = getConfig();
  const method = init?.method ?? 'GET';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    debug(`${method} ${path}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
    const startTime = Date.now();

    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

    const elapsed = Date.now() - startTime;

    if (response.ok) {
      debug(`${method} ${path} -> ${response.status} in ${elapsed}ms`);
      return (await response.json()) as T;
    }

    // Retry on 429 or 5xx, but not on final attempt
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const delay = backoffMs(attempt, response.headers.get('retry-after'));
      debugWarn(`${method} ${path} -> ${response.status}, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    const errorText = await response.text().catch(() => '');
    let notionCode: string | undefined;
    let notionMessage: string | undefined;
    try {
      const parsed = JSON.parse(errorText) as Record<string, unknown>;
      if (typeof parsed.code === 'string') notionCode = parsed.code;
      if (typeof parsed.message === 'string') notionMessage = parsed.message;
    } catch {
      // Not JSON
    }

    debugError(`${method} ${path} failed ${response.status} in ${elapsed}ms`, {
      status: response.status,
      code: notionCode,
      message: notionMessage,
      rawLength: errorText.length,
    });

    const error = new Error(notionMessage || `Notion API error: ${response.status} ${response.statusText}`);
    (error as Error & { status?: number; code?: string }).status = response.status;
    if (notionCode) {
      (error as Error & { code?: string }).code = notionCode;
    }
    throw error;
  }

  // Unreachable but satisfies TS
  throw new Error(`Notion API request failed after ${MAX_RETRIES} retries`);
}
