/**
 * Ends realtime (WebSocket) connections whose credential no longer holds, closes the sockets of
 * connections that revoke paths already ended, and drops query subscribers that no longer belong to
 * a live connection. Revoke paths only mark a connection ended (subscribers pulled, row kept);
 * this sweep owns the socket close: a row is deleted once DeleteConnection succeeded or the socket
 * was already gone, and kept for the next run when the close failed for any other reason. An ended
 * row older than any socket can live is deleted without a close.
 * Schedule: rate(5 minutes) (infra/cron.ts realtimeConnectionSweep).
 * Self-host equivalent: apps/workers/src/selfhost/realtimeConnectionSweep.ts, which runs this same
 * function against the self-host gateway.
 */
import {
  connectDB,
  realtimeConnectionRepository,
  type RealtimeSweepCursor,
  type RealtimeSweepUserState,
  type RealtimeSweepPhase,
  type RealtimeSweepTarget,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { Config } from '@server/utils/config';
import { closeConnection } from '@bike4mind/server-utils/websocket/closeConnection';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'realtimeConnectionSweep' } });

/** Slack past a token's exp, so a client mid-refresh has time to reauth before it is swept. */
export const REALTIME_SWEEP_GRACE_MS = 2 * 60_000;

/** Concurrent DeleteConnection calls; keeps a large backlog from flooding the management API. */
export const REALTIME_SWEEP_CLOSE_CONCURRENCY = 10;

const SWEEP_PHASES: readonly RealtimeSweepPhase[] = ['live', 'ended'];

export interface RealtimeConnectionSweepResult {
  /** Connections this run ended (their credential had lapsed). */
  ended: number;
  /** Sockets closed (or already gone) and rows deleted. */
  closed: number;
  closeFailures: number;
  /** Ended rows deleted without a close because they outlived any possible socket. */
  lapsedDeleted: number;
  /** Pages (chunks) that failed with a database error and were skipped. */
  failedChunks: number;
  orphanedSubscribers: number;
  staleSubscribers: number;
}

type CloseFn = typeof closeConnection;

async function closeAll(
  connectionIds: readonly string[],
  close: CloseFn,
  endpoint: string
): Promise<{ closed: string[]; failures: number }> {
  const closed: string[] = [];
  let failures = 0;
  for (let i = 0; i < connectionIds.length; i += REALTIME_SWEEP_CLOSE_CONCURRENCY) {
    const batch = connectionIds.slice(i, i + REALTIME_SWEEP_CLOSE_CONCURRENCY);
    const outcomes = await Promise.allSettled(batch.map(connectionId => close(connectionId, endpoint)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        closed.push(batch[index]);
        return;
      }
      failures += 1;
      logger.warn(`[realtimeConnectionSweep] Failed to close connection ${batch[index]}`, outcome.reason as Error);
    });
  }
  return { closed, failures };
}

async function processTargets(
  targets: readonly RealtimeSweepTarget[],
  params: { close: CloseFn; endpoint: string; expiredBefore: Date; attempted: Set<string> }
): Promise<Pick<RealtimeConnectionSweepResult, 'ended' | 'closed' | 'closeFailures' | 'lapsedDeleted'>> {
  const { close, endpoint, expiredBefore, attempted } = params;
  const idsWhere = (predicate: (reason: RealtimeSweepTarget['reason']) => boolean) =>
    targets.filter(target => predicate(target.reason)).map(target => target.connectionId);
  const lapsed = idsWhere(reason => reason === 'endedLapsed');
  const alreadyEnded = idsWhere(reason => reason === 'ended');
  const expired = idsWhere(reason => reason === 'expired');
  const otherToEnd = idsWhere(reason => reason !== 'endedLapsed' && reason !== 'ended' && reason !== 'expired');

  // End first (subscribers pulled, row marked): if the close below fails, the ended row stays
  // behind and the next run retries it. An expired row reauthed since classification is not ended
  // (and so not closed).
  const endedExpired =
    expired.length > 0 ? await realtimeConnectionRepository.endExpiredConnections(expired, expiredBefore) : [];
  if (otherToEnd.length > 0) await realtimeConnectionRepository.endConnections({ connectionIds: otherToEnd });
  if (lapsed.length > 0) await realtimeConnectionRepository.deleteEndedConnections(lapsed);

  // A close that already failed this run is not retried by the later 'ended' phase.
  const toClose = [...endedExpired, ...otherToEnd, ...alreadyEnded].filter(id => !attempted.has(id));
  toClose.forEach(id => attempted.add(id));
  const { closed, failures } = await closeAll(toClose, close, endpoint);
  if (closed.length > 0) await realtimeConnectionRepository.deleteEndedConnections(closed);
  return {
    ended: endedExpired.length + otherToEnd.length,
    closed: closed.length,
    closeFailures: failures,
    lapsedDeleted: lapsed.length,
  };
}

export async function runRealtimeConnectionSweep(
  params: { now?: Date; close?: CloseFn } = {}
): Promise<RealtimeConnectionSweepResult> {
  const now = params.now ?? new Date();
  const close = params.close ?? closeConnection;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  const endpoint = Resource.websocket.managementEndpoint;
  const classification = {
    now,
    graceMs: REALTIME_SWEEP_GRACE_MS,
    isAccountBlocked: (user: RealtimeSweepUserState) => userService.accountBlockReasons(user).length > 0,
  };
  const result: RealtimeConnectionSweepResult = {
    ended: 0,
    closed: 0,
    closeFailures: 0,
    lapsedDeleted: 0,
    failedChunks: 0,
    orphanedSubscribers: 0,
    staleSubscribers: 0,
  };
  const reasons: Record<string, number> = {};
  const attempted = new Set<string>();
  const expiredBefore = new Date(now.getTime() - REALTIME_SWEEP_GRACE_MS);

  // One page at a time. A database error in a page is logged and skipped so one bad chunk cannot
  // stop the rest of the run or the subscriber passes below.
  for (const phase of SWEEP_PHASES) {
    let cursor: RealtimeSweepCursor | null = { phase, afterId: null };
    while (cursor) {
      let page: Awaited<ReturnType<typeof realtimeConnectionRepository.readSweepPage>>;
      try {
        page = await realtimeConnectionRepository.readSweepPage(cursor);
      } catch (error) {
        // Without the page there is no position to resume from; the next run starts over.
        logger.error(`[realtimeConnectionSweep] Failed to read a ${phase} page`, error as Error);
        result.failedChunks += 1;
        break;
      }
      cursor = page.next;
      try {
        const targets = await realtimeConnectionRepository.classifySweepRows(page.rows, classification);
        for (const target of targets) reasons[target.reason] = (reasons[target.reason] ?? 0) + 1;
        const outcome = await processTargets(targets, { close, endpoint, expiredBefore, attempted });
        result.ended += outcome.ended;
        result.closed += outcome.closed;
        result.closeFailures += outcome.closeFailures;
        result.lapsedDeleted += outcome.lapsedDeleted;
      } catch (error) {
        logger.error(`[realtimeConnectionSweep] Failed to process a ${phase} chunk`, error as Error);
        result.failedChunks += 1;
      }
    }
  }

  // Separate tries: a throw in one pass must not skip the other.
  try {
    result.orphanedSubscribers = await realtimeConnectionRepository.removeOrphanSubscribers();
  } catch (error) {
    logger.error('[realtimeConnectionSweep] Orphan subscriber cleanup failed', error as Error);
    result.failedChunks += 1;
  }
  try {
    result.staleSubscribers = await realtimeConnectionRepository.removeStaleSubscribers({ now });
  } catch (error) {
    logger.error('[realtimeConnectionSweep] Stale subscriber cleanup failed', error as Error);
    result.failedChunks += 1;
  }

  logger.info('[realtimeConnectionSweep] Sweep complete', { ...result, reasons });
  return result;
}

export const handler = async () => runRealtimeConnectionSweep();
