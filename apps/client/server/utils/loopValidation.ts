/**
 * Shared gate and validators for the `/api/loops` routes. Kept in sync with
 * LoopModel's constraints - see packages/database/src/models/ai/LoopModel.ts.
 */

import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { adminSettingsRepository, loopRepository } from '@bike4mind/database';
import { authorizeOrgChannelPost } from '@bike4mind/server-utils/integrations/slack/orgChannelPost';
import { LOOP_TRIGGERS_MAX, SLACK_CHANNEL_ID_PATTERN, type ILoopTrigger } from '@bike4mind/common';
import { ID_MAX, STAGE_NAME_MAX, validateString, validateStringList } from '@bike4mind/common/loops';

export {
  nextIntervalRunAt,
  nextRunAtFor,
  nextStatusPatch,
  pruneOwnTriggers,
  pruneStageConfig,
  validateLoopAgentId,
  validateLoopBudget,
  validateLoopGoal,
  validateLoopInterval,
  validateLoopMaxConcurrent,
  validateLoopModel,
  validateLoopName,
  validateLoopOrganizationId,
  validateLoopPriorityPolicy,
  validateLoopStageConfig,
  validateLoopStages,
  validateLoopTools,
  validateLoopWakeMode,
} from '@bike4mind/common/loops';

export const LOOP_RATE_LIMIT = 60;
export const LOOP_RATE_WINDOW_MS = 60 * 1000;

const OVERSEES_MAX = 5;
const HANDOFF_TARGETS_MAX = 10;

/** 404 rather than 403 while EnableLoops is off, so the routes don't reveal the feature exists. */
export async function assertLoopsEnabled(): Promise<void> {
  if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) {
    throw new NotFoundError('Not found');
  }
}

/**
 * Ids of the owner's other loops; `null` or `[]` clears it (returned as null). One message for a missing and a
 * foreign id, so the check never confirms another user's loop exists.
 */
async function validateOwnLoopIds(
  field: string,
  value: unknown,
  max: number,
  loopId: string | undefined,
  userId: string
): Promise<string[] | null> {
  if (value === null) return null;
  const ids = validateStringList(field, value, max, ID_MAX);
  if (ids.length === 0) return null;
  if (loopId && ids.includes(loopId)) throw new BadRequestError(`${field} cannot contain the loop itself`);
  const loops = await Promise.all(ids.map(id => loopRepository.findByIdAndUserId(id, userId)));
  if (loops.some(loop => !loop)) throw new BadRequestError(`${field} contains an unknown loop`);
  return ids;
}

/** The owner's other loops this loop oversees. */
export const validateLoopOversees = (value: unknown, loopId: string | undefined, userId: string) =>
  validateOwnLoopIds('oversees', value, OVERSEES_MAX, loopId, userId);

/** The owner's other loops this loop's runs may hand tickets to. Owner moves are not limited by it. */
export const validateLoopHandoffTargets = (value: unknown, loopId: string | undefined, userId: string) =>
  validateOwnLoopIds('handoffTargets', value, HANDOFF_TARGETS_MAX, loopId, userId);

/**
 * Stage triggers on this loop (`ownStages` are its stages): each source an owned other loop, `stage` one of the
 * source's stages, `toStage` one of this loop's non-last stages. One entry per (source, stage); `null` or `[]`
 * clears them (returned as null).
 */
export async function validateLoopTriggers(
  value: unknown,
  loopId: string | undefined,
  userId: string,
  ownStages: readonly string[]
): Promise<ILoopTrigger[] | null> {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > LOOP_TRIGGERS_MAX) {
    throw new BadRequestError(`triggers must be an array of ${LOOP_TRIGGERS_MAX} entries or fewer`);
  }
  if (value.length === 0) return null;
  const seen = new Set<string>();
  const result: ILoopTrigger[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestError('each triggers entry must be an object');
    }
    const entry = raw as Record<string, unknown>;
    const fromLoopId = validateString('triggers fromLoopId', entry.fromLoopId, ID_MAX);
    if (fromLoopId === loopId) throw new BadRequestError('a loop cannot trigger itself');
    const source = await loopRepository.findByIdAndUserId(fromLoopId, userId);
    if (!source) throw new BadRequestError('triggers contains an unknown loop');
    const stage = validateString('triggers stage', entry.stage, STAGE_NAME_MAX);
    if (!source.stages.includes(stage)) {
      throw new BadRequestError(`triggers stage must be one of: ${source.stages.join(', ')}`);
    }
    const key = `${fromLoopId}/${stage}`;
    if (seen.has(key)) throw new BadRequestError('triggers has more than one entry for the same loop and stage');
    seen.add(key);
    const trigger: ILoopTrigger = { fromLoopId, stage };
    if (entry.toStage !== undefined && entry.toStage !== null && entry.toStage !== '') {
      const workable = ownStages.slice(0, -1);
      if (typeof entry.toStage !== 'string' || !workable.includes(entry.toStage)) {
        throw new BadRequestError(`triggers toStage must be one of: ${workable.join(', ')}`);
      }
      trigger.toStage = entry.toStage;
    }
    result.push(trigger);
  }
  return result;
}

/**
 * A Slack channel the loop's runs may post to: the loop bills an org, the channel is opted in for API posting by
 * that org, the owner is a member of it, and the channel does not limit posting to specific API keys (a loop has
 * none). `null` or '' clears it. `loop_slack_post` re-runs the same checks at post time.
 */
export async function validateLoopSlackChannel(
  value: unknown,
  organizationId: string | undefined,
  userId: string
): Promise<string | null> {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !SLACK_CHANNEL_ID_PATTERN.test(value.trim())) {
    throw new BadRequestError('slackChannelId must be a Slack channel id (like C0123ABCD)');
  }
  const channelId = value.trim();
  if (!organizationId) throw new BadRequestError('slackChannelId needs the loop to bill an organization');
  const authorization = await authorizeOrgChannelPost({ channelId, userId });
  if (!authorization.ok || authorization.organizationId !== organizationId) {
    throw new BadRequestError(
      "this channel is not opted in for posting by the loop's organization, or it only allows specific API keys"
    );
  }
  return channelId;
}
