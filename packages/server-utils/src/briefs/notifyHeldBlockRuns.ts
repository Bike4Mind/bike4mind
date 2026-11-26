import { isPushCategoryEnabled, type PushNotificationEvent } from '@bike4mind/common';
import { agentExecutionRepository, userRepository, type BusyBlockInterval } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'notifyHeldBlockRuns' } });

export type HeldBlockRunsDeps = {
  users: Pick<typeof userRepository, 'findById'>;
  runs: Pick<typeof agentExecutionRepository, 'countRunsFinishedBetween'>;
  push(event: PushNotificationEvent): Promise<void>;
  logger: Pick<Logger, 'warn' | 'error'>;
};

const defaultDeps: HeldBlockRunsDeps = {
  users: userRepository,
  runs: agentExecutionRepository,
  // Lazy: pushNotifications reads SST config at load, and startBriefComposition (imported by SST-less
  // tests) imports this module.
  push: async event => (await import('../utils/pushNotifications')).publishPushNotification(event, logger),
  logger,
};

/**
 * The fallback for a block whose brief will not land (no brief started, discarded, failed or too late):
 * sendPush held the completion pushes of runs that finished in it, so one summary push goes out instead.
 * Never throws; callers are on cleanup paths.
 */
export async function notifyHeldBlockRuns(
  userId: string,
  block: BusyBlockInterval,
  deps: HeldBlockRunsDeps = defaultDeps
): Promise<void> {
  try {
    // Mirrors the hold in sendPush, which holds nothing while brief_ready pushes are off.
    const user = await deps.users.findById(userId);
    if (!user || !isPushCategoryEnabled(user.preferences?.pushNotifications, 'brief_ready')) return;
    const count = await deps.runs.countRunsFinishedBetween(userId, block.start, block.end);
    if (count === 0) return;
    await deps.push({
      userId,
      category: 'agent_completed',
      title: 'While you were busy',
      body:
        count === 1
          ? '1 agent run finished during your busy block.'
          : `${count} agent runs finished during your busy block.`,
      deepLink: '/',
      collapseId: `busy_block_runs:${block.end.toISOString()}`,
      busyBlockDigest: true,
    });
  } catch (error) {
    deps.logger.error('[Brief] could not send the held-runs summary for a busy block', { userId, error });
  }
}
