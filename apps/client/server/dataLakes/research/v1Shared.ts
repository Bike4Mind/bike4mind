import type { ResearchKeysetPage } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';

/*
 * Pieces the public v1 research routes share. The rate-limit bucket is a stable string per route
 * family: the raw pathname embeds the lake id, so without it each lake would get its own counter.
 */

export const researchRateLimit = (bucket: string) =>
  rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user, req),
    windowMs: 60 * 1000,
    bucket,
  });

/** Scope for a cursor: the route family and the lake, so a cursor cannot page another list or lake. */
export const cursorScope = (family: string, lakeId: string) => `v1.${family}:${lakeId}`;

/** The repository window for one page. Fetches one extra row to learn whether another page exists. */
export function keysetWindow(
  scope: string,
  { limit, cursor }: { limit: number; cursor?: string }
): Required<Pick<ResearchKeysetPage, 'limit'>> & Pick<ResearchKeysetPage, 'after'> {
  const position = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, scope);
  return { limit: limit + 1, after: position ? { createdAt: position.at, id: position.id } : undefined };
}

/** Trims the extra row and mints `next_cursor` from the last row served. */
export function sliceKeysetPage<T extends { id: string; createdAt?: Date | string }>(
  rows: T[],
  limit: number,
  scope: string
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  if (rows.length <= limit || !last?.createdAt) return { items, next_cursor: null };
  return { items, next_cursor: encodeTimeIdCursor(scope, { at: new Date(last.createdAt), id: last.id }) };
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case body keys to the camelCase the shared handler bodies parse. Undefined keys are dropped. */
export function toCamelInput(body: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [camel(key), value])
  );
}

const HOUR_MS = 60 * 60 * 1000;
const UNDO_HOURLY_CAP = 120;

/** Undo is capped per hour, like its SPA twin, rather than by the per-minute tier. */
export const undoRateLimit = (bucket: string) =>
  rateLimit({
    limit: () => (isDevelopment() ? Infinity : UNDO_HOURLY_CAP),
    windowMs: HOUR_MS,
    bucket,
  });
