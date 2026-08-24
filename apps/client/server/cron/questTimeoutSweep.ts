/**
 * Quest Timeout Sweep
 *
 * Server-side backstop that resolves quests stuck at `status: 'running'` past
 * the liveness threshold. The primary read-time recovery (GET /api/quests/[id])
 * handles API clients that poll, but a quest no client ever reads again stays
 * stuck forever without this cron.
 *
 * Uses the same pure decision function (`resolveQuestTimeoutRecovery`) as the
 * read path so the recovery semantics are defined in exactly one place.
 *
 * Schedule: every 5 minutes
 * Enabled: production + dev
 */

import { connectDB, questRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { Resource } from 'sst';
import { resolveQuestTimeoutRecovery, QUEST_TIMEOUT_THRESHOLD_MS } from '@server/chatCompletion/questTimeoutRecovery';

const logger = new Logger({ metadata: { service: 'questTimeoutSweep' } });

const CLOUDWATCH_NAMESPACE = 'Lumina5/Quests';

export async function handler() {
  const stage = Resource.App.stage;
  logger.info('[QuestTimeoutSweep] Starting sweep', { stage });

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  const olderThan = new Date(Date.now() - QUEST_TIMEOUT_THRESHOLD_MS);
  const staleQuests = await questRepository.findStaleRunning({ olderThan });

  await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRuns', 1, { Stage: stage }, StandardUnit.Count);

  if (staleQuests.length === 0) {
    logger.info('[QuestTimeoutSweep] No stuck quests found');
    await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRecovered', 0, { Stage: stage }, StandardUnit.Count);
    return { status: 'OK', recovered: 0 };
  }

  const nowMs = Date.now();
  let recovered = 0;

  for (const quest of staleQuests) {
    const recovery = resolveQuestTimeoutRecovery(quest, nowMs);
    if (!recovery) continue;

    try {
      await questRepository.update({ id: quest.id, ...recovery });
      recovered++;
      logger.warn('[QuestTimeoutSweep] Recovered stuck quest', { questId: quest.id });
    } catch (err) {
      logger.error('[QuestTimeoutSweep] Failed to recover quest', { questId: quest.id, err });
    }
  }

  logger.info('[QuestTimeoutSweep] Sweep complete', {
    candidates: staleQuests.length,
    recovered,
  });
  await emitMetric(CLOUDWATCH_NAMESPACE, 'TimeoutSweepRecovered', recovered, { Stage: stage }, StandardUnit.Count);

  return { status: 'OK', recovered };
}
