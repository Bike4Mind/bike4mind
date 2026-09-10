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
// Capped at 5s so the retry loop cannot outlive the mcpHandler Lambda's 20s
// wall-clock budget (SST default; no timeout is declared in infra/mcp.ts).
// 60_000 was above that ceiling and could never prevent the Lambda from being
// killed mid-sleep; a single Retry-After response could blow the whole budget.
const MAX_RETRY_AFTER_MS = 5_000;

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    // Clamp rather than discard: honoring a server-supplied hint (even capped)
    // is still better than ignoring it and falling back to exponential backoff.
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

/**
 * Make an authenticated request to the Notion API.
 * Retries on 429 (rate-limited) for any method, and on transient 5xx for reads only.
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

    // A 429 never reached the handler, so replaying it is safe for any method. A 5xx
    // may have landed; Notion has no idempotency key, so replaying POST /pages or
    // PATCH /blocks/{id}/children could double-create. Only reads replay a 5xx.
    const idempotent = method === 'GET' || path === '/search';
    const retryable = response.status === 429 || (idempotent && response.status >= 500);
    if (retryable && attempt < MAX_RETRIES) {
      const delay = backoffMs(attempt, response.headers.get('retry-after'));
      debugWarn(`${method} ${path} -> ${response.status}, retrying in ${delay}ms`);
      // undici keeps the connection checked out until the body is read or cancelled.
      await response.body?.cancel().catch(() => {});
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
