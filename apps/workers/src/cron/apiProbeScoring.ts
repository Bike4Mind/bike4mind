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
 * Request metadata (`clientIp`, `path`, `userId`) comes from apps/client/server/middlewares/requestLogger.ts.
 */

import { rowToObject } from '../utils/logsInsights';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

export const PROBE_SIGNALS = ['refusedFetch', 'webhookSignature', 'invalidId', 'denied', 'notFound'] as const;
export type ProbeSignal = (typeof PROBE_SIGNALS)[number];
export type ProbeSignalCounts = Record<ProbeSignal, number>;

/** Keep in sync with the probeDetectorScoreThreshold description in b4m-core/common/src/schemas/settings.ts. */
export const SIGNAL_WEIGHTS: ProbeSignalCounts = {
  refusedFetch: 10,
  webhookSignature: 5,
  invalidId: 2,
  denied: 1,
  notFound: 1,
};

/**
 * 401/403/404 alone are routine (an expired session polling a handful of routes), so they score
 * only for a pair that also reached this many distinct paths, the shape of route enumeration.
 */
export const BREADTH_GATE_PATHS = 10;

export const QUERY_ROW_LIMIT = 1_000;

const ARROW = '\u2192';

/** Per-line 0/1 indicator for each signal, as Logs Insights expressions over `message`. */
const SIGNAL_EXPRESSIONS: Record<ProbeSignal, string> = {
  refusedFetch: `strcontains(message, "${ARROW} 400: Refusing to fetch")`,
  webhookSignature: 'strcontains(message, "Stripe webhook signature verification failed")',
  invalidId: 'strcontains(message, "[cast-id-remap]")',
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
  ...PROBE_SIGNALS.map(signal => `fields ${SIGNAL_EXPRESSIONS[signal]} as is_${signal}`),
  `fields ${PROBE_SIGNALS.map(signal => `${SIGNAL_WEIGHTS[signal]} * is_${signal}`).join(' + ')} as weight`,
  'stats ' +
    [
      ...PROBE_SIGNALS.map(signal => `sum(is_${signal}) as ${signal}`),
      'sum(weight) as weightTotal',
      'count_distinct(path) as paths',
      'earliest(path) as firstPath',
      'latest(path) as lastPath',
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
  /** Summed over the actor's (IP, user) pairs, so a path seen under two pairs counts twice. */
  distinctPaths: number;
  samplePaths: string[];
}

const toCount = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
};

const emptyCounts = (): ProbeSignalCounts => ({
  refusedFetch: 0,
  webhookSignature: 0,
  invalidId: 0,
  denied: 0,
  notFound: 0,
});

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
    counts.invalidId * SIGNAL_WEIGHTS.invalidId;
  const weak =
    row.distinctPaths >= BREADTH_GATE_PATHS
      ? counts.denied * SIGNAL_WEIGHTS.denied + counts.notFound * SIGNAL_WEIGHTS.notFound
      : 0;
  return strong + weak;
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
    if (row.userId) actor.userSet.add(row.userId);
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
