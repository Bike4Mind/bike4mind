/**
 * Shared gate and validators for the `/api/loops` routes. Kept in sync with
 * LoopModel's constraints - see packages/database/src/models/ai/LoopModel.ts.
 */

import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import type { ILoop, LoopStatus } from '@bike4mind/common';

export const LOOP_RATE_LIMIT = 60;
export const LOOP_RATE_WINDOW_MS = 60 * 1000;

const NAME_MAX = 120;
const GOAL_MAX = 8000;
const TOOLS_MAX = 50;
const TOOL_NAME_MAX = 200;
const ID_MAX = 200;
const STAGES_MAX = 20;
const STAGE_NAME_MAX = 60;
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

export function validateLoopInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < INTERVAL_MIN || value > INTERVAL_MAX) {
    throw new BadRequestError(`intervalMinutes must be an integer from ${INTERVAL_MIN} to ${INTERVAL_MAX}`);
  }
  return value;
}

export function validateLoopBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadRequestError('budgetCreditsPerDay must be a non-negative number');
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
 * failure state, so an errored loop the owner has fixed starts clean.
 */
export function nextStatusPatch(loop: ILoop, requested: unknown, now: Date): Record<string, unknown> {
  if (requested === loop.status) return {};
  const allowedFrom = CLIENT_TRANSITIONS[requested as LoopStatus];
  if (!allowedFrom?.includes(loop.status)) {
    throw new BadRequestError(`Cannot move a loop from ${loop.status} to ${String(requested)}`);
  }
  if (requested === 'paused') return { status: 'paused', statusReason: null };

  return { status: 'live', nextRunAt: nextRunAtFor(loop, now), consecutiveFailures: 0, statusReason: null };
}

/** Now if the loop never ran, else one interval after its last run (never in the past). */
export function nextRunAtFor(loop: Pick<ILoop, 'lastRunAt' | 'intervalMinutes'>, now: Date): Date {
  if (!loop.lastRunAt) return now;
  return new Date(Math.max(now.getTime(), new Date(loop.lastRunAt).getTime() + loop.intervalMinutes * 60 * 1000));
}
