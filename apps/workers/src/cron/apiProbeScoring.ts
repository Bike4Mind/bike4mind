/**
 * Scores per-actor probing of the API from the Next.js server log group. One Logs Insights query
 * counts, per (client IP, user id) pair, the lines that mark a refused or denied attempt; this
 * module turns those rows into scored actors. An actor is the connected set of IPs and user ids
 * that scored, so one person switching IPs, or one IP driving two accounts, is one alert.
 *
 * The message shapes counted here are written by:
 * - apps/client/server/middlewares/errorHandler.ts (`<METHOD> <url> \u2192 <status>: ...` and `[cast-id-remap]`)
 * - apps/client/pages/api/tools/web-fetch.ts, whose refused targets reach that handler as a 400
 * - apps/client/pages/api/stripe/webhook.ts (signature verification failure)
 * - apps/client/server/security/ingestToken.ts (INGEST_TOKEN_REFUSED_MESSAGE, a refused ingest token)
 * Request metadata (`clientIp`, `userId`) comes from apps/client/server/middlewares/requestLogger.ts.
 * Paths are parsed from the error handler line's raw URL, not the `path` field: apps/client/server/middlewares/logging.ts
 * folds every catch-all miss into `/api/:unmatchedApiPath`. Neither carries the query string.
 */

import { INGEST_TOKEN_REFUSED_MESSAGE } from '@server/security/ingestToken';
import { rowToObject } from '../utils/logsInsights';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

/** Signals counted once per matching log line. */
const LINE_SIGNALS = [
  'refusedFetch',
  'webhookSignature',
  'invalidId',
  'ingestTokenRefused',
  'denied',
  'notFound',
] as const;
type LineSignal = (typeof LINE_SIGNALS)[number];

/** `adminDenied` is a count of distinct admin paths, not of lines (see ADMIN_GATE_PATHS). */
export const PROBE_SIGNALS = [...LINE_SIGNALS, 'adminDenied'] as const;
export type ProbeSignal = (typeof PROBE_SIGNALS)[number];
export type ProbeSignalCounts = Record<ProbeSignal, number>;

/** Keep in sync with the probeDetectorScoreThreshold description in b4m-core/common/src/schemas/settings.ts. */
export const SIGNAL_WEIGHTS: ProbeSignalCounts = {
  refusedFetch: 10,
  webhookSignature: 5,
  ingestTokenRefused: 5,
  adminDenied: 3,
  invalidId: 2,
  denied: 1,
  notFound: 1,
};

/** Human labels for alerts and shadow detections. */
export const PROBE_SIGNAL_LABELS: Record<ProbeSignal, string> = {
  refusedFetch: 'refused fetch targets',
  webhookSignature: 'failed Stripe webhook signatures',
  invalidId: 'invalid-id lookups',
  ingestTokenRefused: 'refused ingest tokens',
  adminDenied: 'distinct admin routes denied',
  denied: '401/403 denials from API handlers',
  notFound: '404s',
};

/**
 * Handler 401/403s and 404s alone are routine (a stale tab polling a handful of routes), so they
 * score only for a pair that also failed on this many distinct paths, the shape of route enumeration.
 */
export const BREADTH_GATE_PATHS = 10;

/**
 * Many non-admin screens call an /api/admin route that answers 401/403 for them, so a denied admin
 * path scores only once the pair was denied on this many distinct ones, and then per path, not per
 * request: a page polling the same few admin routes never adds up, a sweep across them does.
 * A denied admin line also counts under `denied`, so a broad admin sweep is weighted by both on purpose.
 */
export const ADMIN_GATE_PATHS = 5;

export const QUERY_ROW_LIMIT = 1_000;

const ARROW = '\u2192';

/** Captures the request path, query string dropped, from an error handler status line. */
export const REQUEST_PATH_PATTERN = `^[A-Z]+ (?<reqPath>[^ ?]+)[^ ]* ${ARROW} [0-9]{3}:`;

/**
 * Captures the route of an /api/admin request the handler answered 401 or 403, cut before the first
 * segment holding anything but letters, `-` or `_`, so record ids (ObjectIds, UUIDs) are not counted
 * as distinct routes.
 */
export const ADMIN_DENIED_PATH_PATTERN = `^[A-Z]+ (?<adminDeniedPath>/api/admin(?:/[A-Za-z_-]+)*)[^ ]* ${ARROW} 40[13]:`;

/** Per-line 0/1 indicator for each line signal, as Logs Insights expressions over `message`. */
const SIGNAL_EXPRESSIONS: Record<LineSignal, string> = {
  refusedFetch: `strcontains(message, "${ARROW} 400: Refusing to fetch")`,
  webhookSignature: 'strcontains(message, "Stripe webhook signature verification failed")',
  // The error handler also writes the 404 status line for a remapped request, so it counts as notFound too.
  invalidId: 'strcontains(message, "[cast-id-remap]")',
  ingestTokenRefused: `strcontains(message, "${INGEST_TOKEN_REFUSED_MESSAGE}")`,
  denied: `strcontains(message, "${ARROW} 401:") + strcontains(message, "${ARROW} 403:")`,
  notFound: `strcontains(message, "${ARROW} 404:")`,
};

/**
 * Lines with neither an IP nor a user (Lambda platform lines, background work) cannot be
 * attributed and are dropped. Rows are ordered by an ungated weight so the row limit keeps the
 * noisiest pairs; the breadth gate is applied after, in scoreRow.
 */
export const PROBE_QUERY = [
  'filter ispresent(clientIp) or ispresent(userId)',
  'fields coalesce(clientIp, "") as ip, coalesce(userId, "") as uid',
  `parse message /${REQUEST_PATH_PATTERN}/`,
  `parse message /${ADMIN_DENIED_PATH_PATTERN}/`,
  ...LINE_SIGNALS.map(signal => `fields ${SIGNAL_EXPRESSIONS[signal]} as is_${signal}`),
  `fields ${LINE_SIGNALS.map(signal => `${SIGNAL_WEIGHTS[signal]} * is_${signal}`).join(' + ')} as weight`,
  'stats ' +
    [
      ...LINE_SIGNALS.map(signal => `sum(is_${signal}) as ${signal}`),
      'sum(weight) as weightTotal',
      'count_distinct(reqPath) as paths',
      'count_distinct(adminDeniedPath) as adminDenied',
      'earliest(reqPath) as firstPath',
      'latest(reqPath) as lastPath',
    ].join(', ') +
    ' by ip, uid',
  'sort weightTotal desc',
  `limit ${QUERY_ROW_LIMIT}`,
].join('\n| ');

export interface ProbeRow {
  ip: string | null;
  userId: string | null;
  counts: ProbeSignalCounts;
  distinctPaths: number;
  samplePaths: string[];
}

export interface ProbeActor {
  ips: string[];
  userIds: string[];
  score: number;
  counts: ProbeSignalCounts;
  /**
   * Each account's own score, summed over its rows. The actor's score includes every account it is
   * linked to (a shared NAT included), so containment looks at these, not at the actor's total.
   */
  userScores: Record<string, number>;
  /** Summed over the actor's (IP, user) pairs, so a path seen under two pairs counts twice. */
  distinctPaths: number;
  samplePaths: string[];
}

const toCount = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
};

const emptyCounts = (): ProbeSignalCounts =>
  Object.fromEntries(PROBE_SIGNALS.map(signal => [signal, 0])) as ProbeSignalCounts;

export function parseProbeRows(rows: ResultField[][]): ProbeRow[] {
  return rows.flatMap(raw => {
    const row = rowToObject(raw);
    const ip = row.ip?.trim() || null;
    const userId = row.uid?.trim() || null;
    if (!ip && !userId) return [];
    const counts = emptyCounts();
    for (const signal of PROBE_SIGNALS) counts[signal] = toCount(row[signal]);
    const samplePaths = [...new Set([row.firstPath, row.lastPath].filter((p): p is string => Boolean(p)))];
    return [{ ip, userId, counts, distinctPaths: toCount(row.paths), samplePaths }];
  });
}

export function scoreRow(row: Pick<ProbeRow, 'counts' | 'distinctPaths'>): number {
  const { counts } = row;
  const strong =
    counts.refusedFetch * SIGNAL_WEIGHTS.refusedFetch +
    counts.webhookSignature * SIGNAL_WEIGHTS.webhookSignature +
    counts.ingestTokenRefused * SIGNAL_WEIGHTS.ingestTokenRefused +
    counts.invalidId * SIGNAL_WEIGHTS.invalidId;
  const admin = counts.adminDenied >= ADMIN_GATE_PATHS ? counts.adminDenied * SIGNAL_WEIGHTS.adminDenied : 0;
  const weak =
    row.distinctPaths >= BREADTH_GATE_PATHS
      ? counts.denied * SIGNAL_WEIGHTS.denied + counts.notFound * SIGNAL_WEIGHTS.notFound
      : 0;
  return strong + admin + weak;
}

const ipNode = (ip: string) => `ip:${ip}`;
const userNode = (userId: string) => `user:${userId}`;

/**
 * Joins scoring rows that share an IP or a user id into actors. Rows that scored zero never link
 * anything, so a shared NAT does not pull its quiet users into a noisy neighbour's alert.
 */
export function groupProbeActors(rows: ProbeRow[]): ProbeActor[] {
  const scored = rows.map(row => ({ row, score: scoreRow(row) })).filter(entry => entry.score > 0);

  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    for (let next = parent.get(root); next !== undefined && next !== root; next = parent.get(root)) root = next;
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const { row } of scored) {
    const nodes = [row.ip && ipNode(row.ip), row.userId && userNode(row.userId)].filter((n): n is string => Boolean(n));
    union(nodes[0], nodes[nodes.length - 1]);
  }

  const actors = new Map<string, ProbeActor & { ipSet: Set<string>; userSet: Set<string>; pathSet: Set<string> }>();
  for (const { row, score } of scored) {
    const root = find(row.ip ? ipNode(row.ip) : userNode(row.userId as string));
    let actor = actors.get(root);
    if (!actor) {
      actor = {
        ips: [],
        userIds: [],
        score: 0,
        counts: emptyCounts(),
        userScores: {},
        distinctPaths: 0,
        samplePaths: [],
        ipSet: new Set(),
        userSet: new Set(),
        pathSet: new Set(),
      };
      actors.set(root, actor);
    }
    actor.score += score;
    actor.distinctPaths += row.distinctPaths;
    for (const signal of PROBE_SIGNALS) actor.counts[signal] += row.counts[signal];
    if (row.ip) actor.ipSet.add(row.ip);
    if (row.userId) {
      actor.userSet.add(row.userId);
      actor.userScores[row.userId] = (actor.userScores[row.userId] ?? 0) + score;
    }
    for (const path of row.samplePaths) actor.pathSet.add(path);
  }

  return [...actors.values()]
    .map(({ ipSet, userSet, pathSet, ...actor }) => ({
      ...actor,
      ips: [...ipSet].sort(),
      userIds: [...userSet].sort(),
      samplePaths: [...pathSet].sort(),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Actors at or above the threshold, highest score first. */
export function actorsOverThreshold(actors: ProbeActor[], threshold: number): ProbeActor[] {
  return actors.filter(actor => actor.score >= threshold);
}
