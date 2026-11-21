import type { Logger } from '@bike4mind/observability';
import { isTopLevelRun } from '../utils/isTopLevelRun';
import { startEventBrief, type ScheduledBriefOutcome } from './startBriefComposition';

export type CompletedRun = {
  userId: string;
  parentExecutionId?: unknown;
  spawnedByExecutionId?: unknown;
  dagNodeId?: string;
};

/**
 * Starts an event brief for a run that just reached `completed`. Shared by every completion site (the
 * executor's terminal frame in apps/workers and the gate Stop/accept paths in apps/client), so they apply
 * the same rule: top-level runs only, and a failure is logged and swallowed, never thrown into the run.
 */
export async function startEventBriefForCompletedRun(
  executionId: string,
  execution: CompletedRun | null | undefined,
  logger: Pick<Logger, 'info' | 'warn'>,
  start: (userId: string) => Promise<ScheduledBriefOutcome> = startEventBrief
): Promise<void> {
  if (!execution || !isTopLevelRun(execution)) return;
  try {
    const outcome = await start(execution.userId);
    logger.info('[EventBrief] agent completion brief start', { executionId, outcome });
  } catch (error) {
    logger.warn('[EventBrief] agent completion brief start failed', {
      executionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
