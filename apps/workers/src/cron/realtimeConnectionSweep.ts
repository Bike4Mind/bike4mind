/**
 * Ends realtime (WebSocket) connections whose credential no longer holds, and drops query
 * subscribers whose connection row is gone. Revoke paths prune connections directly; this sweep
 * catches expiry, anything a revoke path could not reach, and fanout write-backs after a prune.
 * Schedule: rate(5 minutes) (infra/cron.ts realtimeConnectionSweep).
 * Self-host equivalent: apps/workers/src/selfhost/realtimeConnectionSweep.ts.
 */
import { connectDB, realtimeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { Config } from '@server/utils/config';
import { closeConnection } from '@server/websocket/closeConnection';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'realtimeConnectionSweep' } });

/** Slack past a token's exp, so a client mid-refresh has time to reauth before it is swept. */
export const REALTIME_SWEEP_GRACE_MS = 2 * 60_000;

export interface RealtimeConnectionSweepResult {
  ended: number;
  closeFailures: number;
  orphanedSubscribers: number;
}

export async function runRealtimeConnectionSweep(
  params: { now?: Date; close?: typeof closeConnection } = {}
): Promise<RealtimeConnectionSweepResult> {
  const now = params.now ?? new Date();
  const close = params.close ?? closeConnection;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  const targets = await realtimeConnectionRepository.findSweepTargets({
    now,
    graceMs: REALTIME_SWEEP_GRACE_MS,
    isAccountBlocked: user => userService.accountBlockReasons(user).length > 0,
  });

  let ended: string[] = [];
  if (targets.length > 0) {
    ({ connectionIds: ended } = await realtimeConnectionRepository.endConnections({
      connectionIds: targets.map(target => target.connectionId),
    }));
  }

  // Rows are already gone, so a failed close only leaves an idle socket that can no longer
  // subscribe or act; the gateway's idle timeout or 2h cap ends it.
  const endpoint = Resource.websocket.managementEndpoint;
  const closes = await Promise.allSettled(ended.map(connectionId => close(connectionId, endpoint)));
  let closeFailures = 0;
  closes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') return;
    closeFailures += 1;
    logger.warn(`[realtimeConnectionSweep] Failed to close connection ${ended[index]}`, outcome.reason as Error);
  });

  const orphanedSubscribers = await realtimeConnectionRepository.removeOrphanSubscribers();

  const reasons: Record<string, number> = {};
  for (const target of targets) reasons[target.reason] = (reasons[target.reason] ?? 0) + 1;
  logger.info('[realtimeConnectionSweep] Sweep complete', {
    ended: ended.length,
    closeFailures,
    orphanedSubscribers,
    reasons,
  });
  return { ended: ended.length, closeFailures, orphanedSubscribers };
}

export const handler = async () => runRealtimeConnectionSweep();
