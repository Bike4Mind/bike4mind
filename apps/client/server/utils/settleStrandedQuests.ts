import { questRepository } from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import { ABANDONED_REPLY, terminalRecoveryFor } from '@server/chatCompletion/questTimeoutRecovery';

/**
 * Outcome of a settle pass. `failed: true` distinguishes a pass that could not
 * do its job - the read crashed, or at least one quest write was dropped - from
 * a legitimate "nothing was stranded". Both settle 0, and a caller emitting a
 * bare count could not tell them apart on a dashboard.
 */
export interface SettleResult {
  settled: number;
  failed: boolean;
}

/**
 * Give a terminal state to the quests left behind by executions that were just
 * killed off, whatever killed them.
 *
 * Every path that terminates an execution writes only the AgentExecution;
 * without this the bubble keeps its non-terminal status forever, so the run is
 * dead while the UI still presents it as working, with no error and nothing to
 * retry. The liveness-based recovery (`resolveQuestTimeoutRecovery`) cannot
 * reach these: it only considers quests that reached `running`, and a run that
 * died before streaming sits at `pending`, invisible to it.
 *
 * MUST STAY WIRED INTO EVERY EXECUTION-TERMINATING PATH. Four call it today -
 * the abandoned-sweep cron, the admin cleanup endpoint, and the reactive
 * stale-active sweep in both dispatchers (WebSocket start, QuestMaster node
 * runner). A fifth that forgets re-opens the same eternal spinner.
 *
 * Best-effort by design: settling must never fail its caller, whose primary job
 * (releasing execution slots) has already succeeded by the time this runs.
 */
export async function settleStrandedQuests(
  executionIds: string[],
  // A subset rather than `Logger`: callers pass either the class (static methods)
  // or a per-service instance, and both satisfy this.
  logger: Pick<ILogger, 'warn' | 'error'>,
  logPrefix: string
): Promise<SettleResult> {
  if (executionIds.length === 0) return { settled: 0, failed: false };

  let settled = 0;
  let failures = 0;
  try {
    const stranded = await questRepository.findUnfinishedByAgentExecutionIds(executionIds);
    for (const quest of stranded) {
      try {
        // Conditional on the quest still being unfinished, because this loop
        // writes one quest per round trip: a natural completion can land
        // between the read above and this write, and an unconditional patch
        // would replace its real answer with the abandoned-run error.
        const applied = await questRepository.settleIfUnfinished(quest.id, terminalRecoveryFor(quest, ABANDONED_REPLY));
        if (applied) settled += 1;
      } catch (err) {
        // Counted, not just logged. The execution is already terminal, so no
        // later sweep revisits it: a dropped write strands that bubble for
        // good, and reporting the pass as clean would hide it from the alarm
        // that exists to catch exactly this.
        failures += 1;
        logger.warn(`${logPrefix} Failed to settle stranded quest`, { questId: quest.id, err });
      }
    }
    if (settled > 0 || failures > 0) {
      logger.warn(`${logPrefix} Settled stranded quests`, { stranded: stranded.length, settled, failures });
    }
  } catch (err) {
    logger.error(`${logPrefix} Stranded-quest settle pass failed`, { err });
    return { settled, failed: true };
  }
  return { settled, failed: failures > 0 };
}
