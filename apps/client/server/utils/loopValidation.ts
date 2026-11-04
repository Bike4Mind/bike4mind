/**
 * Shared gate and validators for the `/api/loops` routes. Kept in sync with
 * LoopModel's constraints - see packages/database/src/models/ai/LoopModel.ts.
 */

import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { adminSettingsRepository, loopRepository } from '@bike4mind/database';
import {
  LOOP_MERGE_POLICIES,
  LOOP_STAGE_RUNNERS,
  type ILoop,
  type ILoopStageConfig,
  type LoopMergePolicy,
  type LoopStatus,
} from '@bike4mind/common';

export const LOOP_RATE_LIMIT = 60;
export const LOOP_RATE_WINDOW_MS = 60 * 1000;

const NAME_MAX = 120;
const GOAL_MAX = 8000;
const TOOLS_MAX = 50;
const TOOL_NAME_MAX = 200;
const ID_MAX = 200;
const STAGES_MAX = 20;
const STAGE_NAME_MAX = 60;
const OVERSEES_MAX = 5;
const STAGE_INSTRUCTIONS_MAX = 4000;
const REPO_HINT = /^[\w.-]+\/[\w.-]+$/;
const SMOKE_URL_MAX = 2000;
const SMOKE_COMMAND_MAX = 1000;
const HOLD_LABELS_MAX = 20;
const HOLD_LABEL_MAX = 100;
const INTERVAL_MIN = 5;
/** One week. */
const INTERVAL_MAX = 10_080;

/** 404 rather than 403 while EnableLoops is off, so the routes don't reveal the feature exists. */
export async function assertLoopsEnabled(): Promise<void> {
  if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) {
    throw new NotFoundError('Not found');
  }
}

function validateString(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new BadRequestError(`${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

function validateStringList(field: string, value: unknown, maxEntries: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError(`${field} must be an array of strings`);
  }
  if (value.length > maxEntries) {
    throw new BadRequestError(`${field} must contain ${maxEntries} entries or fewer`);
  }
  return Array.from(new Set(value.map(entry => validateString(`each ${field} entry`, entry, maxLength))));
}

export const validateLoopName = (value: unknown) => validateString('name', value, NAME_MAX);
export const validateLoopGoal = (value: unknown) => validateString('goal', value, GOAL_MAX);
export const validateLoopModel = (value: unknown) => validateString('model', value, ID_MAX);
export const validateLoopAgentId = (value: unknown) => validateString('agentId', value, ID_MAX);
export const validateLoopOrganizationId = (value: unknown) => validateString('organizationId', value, ID_MAX);
export const validateLoopTools = (value: unknown) => validateStringList('tools', value, TOOLS_MAX, TOOL_NAME_MAX);
// Two at least: a ticket's last stage means closed, so it needs one stage to be worked in (see loopTickets.ts).
export function validateLoopStages(value: unknown): string[] {
  const stages = validateStringList('stages', value, STAGES_MAX, STAGE_NAME_MAX);
  if (stages.length < 2) throw new BadRequestError('stages must contain at least 2 distinct entries');
  return stages;
}

/**
 * Per-stage config against the loop's `stages`; `null` clears it. Empty strings and empty tool lists count as
 * unset, and entries left with nothing set, or for the last stage (closed, never worked), are dropped.
 */
export function validateLoopStageConfig(value: unknown, stages: readonly string[]): ILoopStageConfig[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > STAGES_MAX) {
    throw new BadRequestError(`stageConfig must be an array of ${STAGES_MAX} entries or fewer`);
  }
  const seen = new Set<string>();
  const result: ILoopStageConfig[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestError('each stageConfig entry must be an object');
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.stage !== 'string' || !stages.includes(entry.stage)) {
      throw new BadRequestError(`stageConfig stage must be one of: ${stages.join(', ')}`);
    }
    if (seen.has(entry.stage)) throw new BadRequestError(`stageConfig has more than one entry for ${entry.stage}`);
    seen.add(entry.stage);

    const config: ILoopStageConfig = { stage: entry.stage };
    const text = (field: string, max: number) => {
      const v = entry[field];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return undefined;
      if (typeof v !== 'string') throw new BadRequestError(`stageConfig ${field} must be a string`);
      return validateString(field, v, max);
    };
    const instructions = text('instructions', STAGE_INSTRUCTIONS_MAX);
    if (instructions) config.instructions = instructions;
    const model = text('model', ID_MAX);
    if (model) config.model = model;
    if (entry.tools !== undefined && entry.tools !== null) {
      const tools = validateStringList('tools', entry.tools, TOOLS_MAX, TOOL_NAME_MAX);
      if (tools.length) config.tools = tools;
    }
    if (entry.runner !== undefined && entry.runner !== null) {
      if (!LOOP_STAGE_RUNNERS.includes(entry.runner as ILoopStageConfig['runner'] & string)) {
        throw new BadRequestError(`stageConfig runner must be one of: ${LOOP_STAGE_RUNNERS.join(', ')}`);
      }
      config.runner = entry.runner as ILoopStageConfig['runner'];
    }
    const guards = validateStageGuards(entry, text);
    if (Object.keys(guards).length > 0) {
      if (config.runner !== 'desktop') {
        throw new BadRequestError(
          'stageConfig repoHint, mergePolicy, deployWorkflow, smoke and holdLabels only apply to desktop stages'
        );
      }
      Object.assign(config, guards);
    }
    if (entry.stage !== stages[stages.length - 1] && Object.keys(config).length > 1) result.push(config);
  }
  return result;
}

/** A desktop stage's guard fields; empty values count as unset. */
function validateStageGuards(
  entry: Record<string, unknown>,
  text: (field: string, max: number) => string | undefined
): Pick<ILoopStageConfig, 'repoHint' | 'mergePolicy' | 'deployWorkflow' | 'smoke' | 'holdLabels'> {
  const guards: ReturnType<typeof validateStageGuards> = {};
  const repoHint = text('repoHint', ID_MAX);
  if (repoHint) {
    if (!REPO_HINT.test(repoHint)) throw new BadRequestError('stageConfig repoHint must look like owner/name');
    guards.repoHint = repoHint;
  }
  if (entry.mergePolicy !== undefined && entry.mergePolicy !== null && entry.mergePolicy !== '') {
    if (!LOOP_MERGE_POLICIES.includes(entry.mergePolicy as LoopMergePolicy)) {
      throw new BadRequestError(`stageConfig mergePolicy must be one of: ${LOOP_MERGE_POLICIES.join(', ')}`);
    }
    guards.mergePolicy = entry.mergePolicy as LoopMergePolicy;
  }
  const deployWorkflow = text('deployWorkflow', ID_MAX);
  if (deployWorkflow) guards.deployWorkflow = deployWorkflow;
  if (entry.smoke !== undefined && entry.smoke !== null) {
    if (typeof entry.smoke !== 'object' || Array.isArray(entry.smoke)) {
      throw new BadRequestError('stageConfig smoke must be an object with a url or a command');
    }
    const smoke = entry.smoke as Record<string, unknown>;
    const field = (name: string, max: number) =>
      smoke[name] === undefined || smoke[name] === null || smoke[name] === ''
        ? undefined
        : validateString(`smoke ${name}`, smoke[name], max);
    const url = field('url', SMOKE_URL_MAX);
    const command = field('command', SMOKE_COMMAND_MAX);
    if (url && command) throw new BadRequestError('stageConfig smoke takes a url or a command, not both');
    if (url) {
      if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
        throw new BadRequestError('stageConfig smoke url must be an http(s) URL');
      }
      guards.smoke = { url };
    } else if (command) {
      guards.smoke = { command };
    }
  }
  if (entry.holdLabels !== undefined && entry.holdLabels !== null) {
    const labels = validateStringList('holdLabels', entry.holdLabels, HOLD_LABELS_MAX, HOLD_LABEL_MAX);
    if (labels.length) guards.holdLabels = labels;
  }
  return guards;
}

/** Drops config for stages no longer in `stages` or now the last one, so a stage edit leaves no orphans. */
export const pruneStageConfig = (stageConfig: ILoopStageConfig[], stages: readonly string[]): ILoopStageConfig[] =>
  stageConfig.filter(entry => stages.includes(entry.stage) && entry.stage !== stages[stages.length - 1]);

/**
 * The owner's other loops this loop oversees; `null` or `[]` clears it (returned as null). One message for a
 * missing and a foreign id, so the check never confirms another user's loop exists.
 */
export async function validateLoopOversees(value: unknown, loopId: string | undefined, userId: string) {
  if (value === null) return null;
  const ids = validateStringList('oversees', value, OVERSEES_MAX, ID_MAX);
  if (ids.length === 0) return null;
  if (loopId && ids.includes(loopId)) throw new BadRequestError('a loop cannot oversee itself');
  const loops = await Promise.all(ids.map(id => loopRepository.findByIdAndUserId(id, userId)));
  if (loops.some(loop => !loop)) throw new BadRequestError('oversees contains an unknown loop');
  return ids;
}

export function validateLoopInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < INTERVAL_MIN || value > INTERVAL_MAX) {
    throw new BadRequestError(`intervalMinutes must be an integer from ${INTERVAL_MIN} to ${INTERVAL_MAX}`);
  }
  return value;
}

export function validateLoopBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BadRequestError('budgetCreditsPerDay must be a positive number');
  }
  return value;
}

/** Statuses a client may move a loop to, keyed by the target. The rest are set by the scheduler. */
const CLIENT_TRANSITIONS: Partial<Record<LoopStatus, readonly LoopStatus[]>> = {
  live: ['draft', 'paused', 'needs_you', 'error'],
  paused: ['live'],
};

/**
 * The patch for a client-requested status change. Going `live` schedules the next run
 * (now if the loop never ran, else one interval after the last run) and clears the
 * failure state, so an errored loop the owner has fixed starts clean. Every owner move
 * clears `autoResume`: pausing a loop the scheduler paused makes it an owner pause.
 */
export function nextStatusPatch(loop: ILoop, requested: unknown, now: Date): Record<string, unknown> {
  if (requested === loop.status) {
    return requested === 'paused' && loop.autoResume ? { statusReason: null, autoResume: null } : {};
  }
  const allowedFrom = CLIENT_TRANSITIONS[requested as LoopStatus];
  if (!allowedFrom?.includes(loop.status)) {
    throw new BadRequestError(`Cannot move a loop from ${loop.status} to ${String(requested)}`);
  }
  if (requested === 'paused') return { status: 'paused', statusReason: null, autoResume: null };

  return {
    status: 'live',
    nextRunAt: nextRunAtFor(loop, now),
    consecutiveFailures: 0,
    statusReason: null,
    autoResume: null,
  };
}

/** Now if the loop never ran, else one interval after its last run (never in the past). */
export function nextRunAtFor(loop: Pick<ILoop, 'lastRunAt' | 'intervalMinutes'>, now: Date): Date {
  if (!loop.lastRunAt) return now;
  return new Date(Math.max(now.getTime(), new Date(loop.lastRunAt).getTime() + loop.intervalMinutes * 60 * 1000));
}
