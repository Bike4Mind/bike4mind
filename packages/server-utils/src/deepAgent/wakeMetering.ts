import {
  BadRequestError,
  ForbiddenError,
  getQuestErrorCode,
  isSpendFrozenError,
  type IUserDocument,
  type TooManyRequestsError,
} from '@bike4mind/common';
import { deepAgentHandoffRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { assertOwnerHasCredits } from '@bike4mind/services';
import { aiAccessDeniedMessage, isAiAccessRefusal } from '@bike4mind/services/userService/accountState';
import { usdToCredits } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import type { CompletionMeter } from '@bike4mind/services';
import type { DeepAgentStore } from '@bike4mind/agents';
import {
  assertOwnerCanAfford,
  completionCeilingUsd,
  createCompletionMeter,
  isCreditsEnforced,
} from '../billing/meterPlatformCompletion';
import { buildSystemApiKeyTable, DEFAULT_WAKE_MODEL_ID } from './resolveBackend';

// No resume path exists: pauseMission clears the interval and nothing restores it after a top-up.
export const MISSION_NEEDS_CREDITS_BLOCKER =
  'stopped: the mission owner ran out of credits. Topping up does not restart it; start a new mission to continue';
export const MISSION_MODEL_REFUSED_BLOCKER =
  'stopped: the mission model is not available to its owner. Start a new mission once it is available';

// Every account-standing refusal and a spend freeze can be lifted (dispute resolved, suspension or moderation
// lifted, deletion cancelled, review approved, spending resumed), so the mission waits and rechecks instead of pausing.
export const MISSION_OWNER_RESTRICTED_BLOCKER =
  "waiting: the mission owner's account cannot use AI right now; the mission resumes on its own once that is resolved";
export const MISSION_SPEND_FROZEN_BLOCKER =
  'waiting: spending is paused for the mission owner; the mission resumes on its own once spending is resumed';
const ACCOUNT_HOLD_BLOCKERS = [MISSION_OWNER_RESTRICTED_BLOCKER, MISSION_SPEND_FROZEN_BLOCKER];

/** How long a wake for a restricted owner waits before rechecking, in ms. One user read per recheck, no LLM. */
export const ACCOUNT_HOLD_RECHECK_MS = 60 * 60 * 1000;

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
      // Disabled models use 400, while entitlement and pricing refusals use 403. An account-standing
      // refusal passes through as-is so the wake defers instead of pausing. A spend freeze is also a
      // 403 but is about the owner, not the model, so it keeps its own classifier.
      if (isAiAccessRefusal(err)) throw err;
      if (isSpendFrozenError(err)) throw err;
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

/**
 * The account-standing refusal for a user, or null when they may use AI (or no longer exist). Reads the user
 * fresh and does not consult isCreditsEnforced: standing applies whether or not credits are enforced.
 */
export async function userAiAccessDenial(userId: string): Promise<string | null> {
  const user = (await userRepository.findById(userId)) as IUserDocument | null;
  return user ? aiAccessDeniedMessage(user) : null;
}

/** The account-standing refusal for a mission's owner, or null when the mission may run. */
export async function ownerAiAccessDenial(store: DeepAgentStore, agentId: string): Promise<string | null> {
  const charter = await store.loadCharter(agentId);
  return charter ? userAiAccessDenial(charter.identity.ownerUserId) : null;
}

/** Throws the 403 an AI route gives a restricted account when the mission's owner may not use AI. */
export async function assertMissionOwnerCanUseAi(store: DeepAgentStore, agentId: string): Promise<void> {
  const denial = await ownerAiAccessDenial(store, agentId);
  if (denial) throw new ForbiddenError(denial);
}

/**
 * Hold a scheduled mission while its owner's account is restricted or its spending frozen: show the blocker,
 * keep the interval, and push the next wake out by ACCOUNT_HOLD_RECHECK_MS. A paused mission (no interval)
 * stays paused; one held before its first wake gets a handoff seeded so the cron rechecks it.
 */
export async function deferWakeForAccountStanding(
  store: DeepAgentStore,
  agentId: string,
  logger: Logger,
  blocker: string = MISSION_OWNER_RESTRICTED_BLOCKER
): Promise<void> {
  const handoff = await store.loadHandoff(agentId);
  const nowIso = new Date().toISOString();
  if (!handoff) {
    await store.saveHandoff({
      agentId,
      wakeCount: 0,
      lastWakeAt: nowIso,
      lastActionSummary: '',
      nextIntendedAction: '',
      openBlockers: [blocker],
      updatedAt: nowIso,
    });
  } else if (!handoff.openBlockers.includes(blocker)) {
    await store.saveHandoff({
      ...handoff,
      openBlockers: [...handoff.openBlockers, blocker],
      updatedAt: nowIso,
    });
  }
  if (handoff && handoff.wakeCount > 0 && handoff.nextWakeIntervalMs == null) return;
  // After the save: saving re-derives nextWakeAt from lastWakeAt + interval (DeepAgentHandoffModel.upsertForAgent).
  const resumeAt = new Date(Date.now() + ACCOUNT_HOLD_RECHECK_MS);
  await deepAgentHandoffRepository.releaseWakeClaim(agentId, resumeAt);
  logger.warn('deep agent wake: owner cannot spend on AI right now; deferring', { agentId, blocker, resumeAt });
}

/**
 * Drop the account-hold blockers before a wake. A freeze is only detected mid-wake, so a still-frozen owner's
 * wake re-adds its blocker when the meter refuses.
 */
export async function clearAccountStandingBlocker(store: DeepAgentStore, agentId: string): Promise<void> {
  const handoff = await store.loadHandoff(agentId);
  if (!handoff?.openBlockers.some(b => ACCOUNT_HOLD_BLOCKERS.includes(b))) return;
  // Saving re-derives nextWakeAt, which would drop the cron's claim lease (claimDueAgentIds) mid-wake.
  const lease = (await deepAgentHandoffRepository.findByAgentId(agentId))?.nextWakeAt;
  await store.saveHandoff({
    ...handoff,
    openBlockers: handoff.openBlockers.filter(b => !ACCOUNT_HOLD_BLOCKERS.includes(b)),
    updatedAt: new Date().toISOString(),
  });
  if (lease) await deepAgentHandoffRepository.releaseWakeClaim(agentId, lease);
}
