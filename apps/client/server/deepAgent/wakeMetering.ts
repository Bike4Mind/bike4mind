import { ForbiddenError, getQuestErrorCode, type IUserDocument } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { assertOwnerHasCredits } from '@bike4mind/services';
import { usdToCredits } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import type { CompletionMeter } from '@bike4mind/services';
import type { DeepAgentStore } from '@bike4mind/agents';
import {
  assertOwnerCanAfford,
  completionCeilingUsd,
  createCompletionMeter,
  isCreditsEnforced,
} from '@server/billing/meterPlatformCompletion';
import { buildSystemApiKeyTable, DEFAULT_WAKE_MODEL_ID } from './resolveBackend';

// No resume path exists: pauseMission clears the interval and nothing restores it after a top-up.
export const MISSION_NEEDS_CREDITS_BLOCKER =
  'stopped: the mission owner ran out of credits. Topping up does not restart it; start a new mission to continue';
export const MISSION_MODEL_REFUSED_BLOCKER =
  'stopped: the mission model is not available to its owner. Start a new mission once it is available';

/** A model-admission refusal during a wake, as opposed to any other ForbiddenError. */
export class MissionModelRefusedError extends ForbiddenError {}

/** Largest max_tokens any single wake LLM call requests (see llmSteps). */
const WAKE_MAX_OUTPUT_TOKENS = 8000;

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
  const meter = createCompletionMeter(owner, logger, 'mission wake');
  return async (...args) => {
    try {
      return await meter(...args);
    } catch (err) {
      if (err instanceof ForbiddenError) throw new MissionModelRefusedError(err.message, err.additionalInfo);
      throw err;
    }
  };
}

/**
 * Pre-enrollment gate: the first wake reserves a full call ceiling, so refuse an owner who cannot
 * fund one (a bare balance > 0 check would enroll a charter whose first wake is then refused).
 */
export async function assertOwnerCanFundWake(owner: IUserDocument, logger: Logger): Promise<void> {
  await assertOwnerCanAfford(owner);
  if (!(await isCreditsEnforced())) return;
  const models = await getAvailableModels(await buildSystemApiKeyTable(logger));
  const modelInfo = models.find(m => m.id === DEFAULT_WAKE_MODEL_ID);
  if (!modelInfo) return;
  const requiredCredits = usdToCredits(completionCeilingUsd(modelInfo, [], WAKE_MAX_OUTPUT_TOKENS));
  const org = owner.organizationId ? await organizationRepository.findById(String(owner.organizationId)) : null;
  assertOwnerHasCredits(org ?? owner, { requiredCredits });
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
