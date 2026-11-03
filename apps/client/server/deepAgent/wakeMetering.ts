import {
  BadRequestError,
  ForbiddenError,
  getQuestErrorCode,
  type IUserDocument,
  type TooManyRequestsError,
} from '@bike4mind/common';
import { deepAgentHandoffRepository, organizationRepository, userRepository } from '@bike4mind/database';
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
import { buildSystemApiKeyTable, DEFAULT_WAKE_MODEL_ID } from '@bike4mind/server-utils/deepAgent/resolveBackend';

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
      // This meter runs admission and reservation only; provider errors occur after it returns.
      // Disabled models use 400, while entitlement and pricing refusals use 403.
      if (err instanceof ForbiddenError || err instanceof BadRequestError) {
        throw new MissionModelRefusedError(err.message, err.additionalInfo);
      }
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

/** Fallback when a cap refusal carries no Retry-After, in ms. */
const CAP_RESET_FALLBACK_MS = 60 * 60 * 1000;

/**
 * The free-tier daily cap clears at the next UTC midnight, so pausing the mission (as for an empty
 * balance) would be too harsh, and letting the cron re-claim it every lease would re-refuse until
 * then. Push the next wake to the cap's Retry-After instead.
 */
export async function deferWakeUntilCapReset(
  agentId: string,
  err: TooManyRequestsError,
  logger: Logger
): Promise<void> {
  const retryAfterSeconds = err.additionalInfo?.retryAfter;
  const delayMs = typeof retryAfterSeconds === 'number' ? retryAfterSeconds * 1000 : CAP_RESET_FALLBACK_MS;
  const resumeAt = new Date(Date.now() + delayMs);
  await deepAgentHandoffRepository.releaseWakeClaim(agentId, resumeAt);
  logger.info('deep agent wake: owner hit the free-tier daily cap; deferring', { agentId, resumeAt });
}

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
