import { getQuestErrorCode, type IUserDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { CompletionMeter } from '@bike4mind/services';
import type { DeepAgentStore } from '@bike4mind/agents';
import { createCompletionMeter } from '@server/billing/meterPlatformCompletion';

export const MISSION_NEEDS_CREDITS_BLOCKER = 'needs credits: the mission owner is out of credits';
export const MISSION_MODEL_REFUSED_BLOCKER = 'model unavailable: the mission model is not available to its owner';

/** Bills each wake LLM call to the mission owner (their org seat when present). */
export async function missionWakeMeter(
  store: DeepAgentStore,
  agentId: string,
  logger: Logger
): Promise<CompletionMeter> {
  const charter = await store.loadCharter(agentId);
  if (!charter) throw new Error(`deep agent wake: no charter for ${agentId}`);
  const owner = (await userRepository.findById(charter.identity.ownerUserId)) as IUserDocument | null;
  if (!owner) throw new Error(`deep agent wake: owner ${charter.identity.ownerUserId} not found`);
  return createCompletionMeter(owner, logger, 'mission wake');
}

export const isInsufficientCredits = (err: unknown): boolean => getQuestErrorCode(err) === 'insufficient_credits';

/**
 * Stop scheduling a mission whose next wake cannot run (owner out of credits, model no longer
 * admitted): clearing the interval clears nextWakeAt, so the wake cron never claims it again, and
 * the blocker shows on the dossier.
 */
export async function pauseMission(
  store: DeepAgentStore,
  agentId: string,
  blocker: string,
  logger: Logger
): Promise<void> {
  const handoff = await store.loadHandoff(agentId);
  if (!handoff) return;
  await store.saveHandoff({
    ...handoff,
    nextWakeIntervalMs: undefined,
    openBlockers: [...handoff.openBlockers.filter(b => b !== blocker), blocker],
    updatedAt: new Date().toISOString(),
  });
  logger.warn('deep agent wake: paused mission', { agentId, blocker });
}
