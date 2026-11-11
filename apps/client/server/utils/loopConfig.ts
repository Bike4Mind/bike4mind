import isEqual from 'lodash/isEqual';
import {
  LOOP_VERSIONED_FIELDS,
  stageConfigOf,
  type ILoop,
  type ILoopConfigChange,
  type LoopConfigChangeBy,
  type LoopVersionedField,
} from '@bike4mind/common';
import { loopEventRepository, loopRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { requestLoopDispatch } from './loopDispatch';
import { makeDueIfReady } from './loopTickets';
import { loopConfigChangeSummary } from './loopConfigSummary';
import {
  nextRunAtFor,
  nextStatusPatch,
  pruneOwnTriggers,
  pruneStageConfig,
  validateLoopAgentId,
  validateLoopBudget,
  validateLoopGoal,
  validateLoopHandoffTargets,
  validateLoopInterval,
  validateLoopMaxConcurrent,
  validateLoopModel,
  validateLoopName,
  validateLoopOversees,
  validateLoopPriorityPolicy,
  validateLoopStageConfig,
  validateLoopStages,
  validateLoopTools,
  validateLoopTriggers,
  validateLoopWakeMode,
} from './loopValidation';

/** A `PATCH /api/loops/:id` body. These fields are widened to allow the explicit null that clears them. */
export type LoopConfigBody = Partial<
  Omit<
    ILoop,
    'agentId' | 'budgetCreditsPerDay' | 'maxConcurrent' | 'oversees' | 'handoffTargets' | 'triggers' | 'wakeMode'
  >
> & {
  agentId?: string | null;
  budgetCreditsPerDay?: number | null;
  maxConcurrent?: number | null;
  oversees?: string[] | null;
  handoffTargets?: string[] | null;
  triggers?: unknown;
  wakeMode?: string | null;
};

// A JSON copy: the event stores plain values, and undefined and null both mean unset. Order-only differences
// (the edit form rebuilds stageConfig in stage order; the coach appends) and unset lanes (= 1, as the summary
// reads them) are not changes, so a no-op save neither logs a version nor trips the undo guard.
const versioned = (loop: Partial<ILoop>, field: LoopVersionedField): unknown => {
  const value = JSON.parse(JSON.stringify(loop[field] ?? null));
  if (field === 'maxConcurrent') return value ?? 1;
  if (field === 'tools' && value) return [...value].sort();
  if (field === 'stageConfig' && value) {
    return [...value].sort((a: { stage: string }, b: { stage: string }) => a.stage.localeCompare(b.stage));
  }
  return value;
};

/** The versioned fields whose values differ between two reads of a loop. */
export function changedVersionedFields(before: Partial<ILoop>, after: Partial<ILoop>): LoopVersionedField[] {
  return LOOP_VERSIONED_FIELDS.filter(field => !isEqual(versioned(before, field), versioned(after, field)));
}

/** Whether every field in `values` still holds that value on `loop` (the undo and revert guard). */
export function loopMatches(loop: Partial<ILoop>, values: Partial<Record<LoopVersionedField, unknown>>): boolean {
  return Object.entries(values).every(([field, value]) =>
    isEqual(versioned(loop, field as LoopVersionedField), value ?? null)
  );
}

/** The model a stage runs on before any escalation. */
export const stageModelOf = (loop: Pick<ILoop, 'model' | 'stageConfig'>, stage: string): string =>
  stageConfigOf(loop, stage).model ?? loop.model;

export interface ApplyLoopConfigPatchInput {
  existing: ILoop;
  body: LoopConfigBody;
  userId: string;
  logger: Logger;
  by: LoopConfigChangeBy;
  suggestionKey?: string;
  /** Server-built fields written with the patch, unvalidated (the coach trial). Never from a request body. */
  extraPatch?: Partial<Record<'coachTrial', unknown>>;
  /** Logs an event even when no versioned field changed (a trial kept), with this reason. */
  reason?: string;
}

/**
 * The one writer of loop settings: owner PATCH and every coach action (apply, trial, undo) go through it, so the coach
 * can never write a value PATCH would reject. Validates `body` like PATCH, keeps its side effects (stageConfig and
 * trigger pruning, wake and interval rescheduling, idle back-off reset, dispatch), writes conditionally on the status
 * and stages it read (a lost race is a 409), then logs one `config_changed` event with the changed versioned fields.
 * A non-trial write that changes the trial stage's model, or removes that stage, ends the trial.
 */
export async function applyLoopConfigPatch({
  existing,
  body,
  userId,
  logger,
  by,
  suggestionKey,
  extraPatch,
  reason,
}: ApplyLoopConfigPatchInput): Promise<{ loop: ILoop; eventId?: string }> {
  const id = existing.id;
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = validateLoopName(body.name);
  if (body.goal !== undefined) patch.goal = validateLoopGoal(body.goal);
  if (body.model !== undefined) patch.model = validateLoopModel(body.model);
  if (body.intervalMinutes !== undefined) patch.intervalMinutes = validateLoopInterval(body.intervalMinutes);
  if (body.tools !== undefined) patch.tools = validateLoopTools(body.tools);
  if (body.stages !== undefined) patch.stages = validateLoopStages(body.stages);
  const stages = (patch.stages as string[] | undefined) ?? existing.stages;
  if (body.stageConfig !== undefined) {
    const stageConfig = validateLoopStageConfig(body.stageConfig, stages);
    patch.stageConfig = stageConfig?.length ? stageConfig : null;
  } else if (patch.stages && existing.stageConfig) {
    const pruned = pruneStageConfig(existing.stageConfig, stages);
    patch.stageConfig = pruned.length ? pruned : null;
  }
  if (body.agentId !== undefined) patch.agentId = body.agentId === null ? null : validateLoopAgentId(body.agentId);
  if (body.budgetCreditsPerDay !== undefined) {
    patch.budgetCreditsPerDay = body.budgetCreditsPerDay === null ? null : validateLoopBudget(body.budgetCreditsPerDay);
  }
  if (body.maxConcurrent !== undefined) {
    patch.maxConcurrent = body.maxConcurrent === null ? null : validateLoopMaxConcurrent(body.maxConcurrent);
  }
  if (body.oversees !== undefined) {
    patch.oversees = await validateLoopOversees(body.oversees, existing.id, userId);
  }
  if (body.handoffTargets !== undefined) {
    patch.handoffTargets = await validateLoopHandoffTargets(body.handoffTargets, existing.id, userId);
  }
  if (body.triggers !== undefined) {
    patch.triggers = await validateLoopTriggers(body.triggers, existing.id, userId, stages);
  } else if (patch.stages && existing.triggers?.length) {
    patch.triggers = pruneOwnTriggers(existing.triggers, stages);
  }
  if (body.wakeMode !== undefined) patch.wakeMode = validateLoopWakeMode(body.wakeMode);
  Object.assign(patch, validateLoopPriorityPolicy(body as Record<string, unknown>));
  const now = new Date();
  const wakeMode =
    patch.wakeMode === undefined ? existing.wakeMode : ((patch.wakeMode as ILoop['wakeMode']) ?? undefined);
  const ticketsOnly = wakeMode === 'tickets';
  if (body.status !== undefined) Object.assign(patch, nextStatusPatch({ ...existing, wakeMode }, body.status, now));
  // A wake-mode switch on a live loop: to tickets drops the interval's next run (a ready ticket makes it due again
  // below); back to interval schedules one, since a tickets-mode loop may have none.
  if (
    existing.status === 'live' &&
    patch.nextRunAt === undefined &&
    (wakeMode ?? 'interval') !== (existing.wakeMode ?? 'interval')
  ) {
    patch.nextRunAt = ticketsOnly ? null : nextRunAtFor({ ...existing, wakeMode }, now);
  }
  // A new interval on a live loop moves its next run, not just the one after. An unchanged one (the edit
  // form always sends it) must not, or saving would push back a pending Run now.
  const intervalMinutes = patch.intervalMinutes as number | undefined;
  if (
    !ticketsOnly &&
    intervalMinutes !== undefined &&
    intervalMinutes !== existing.intervalMinutes &&
    existing.status === 'live' &&
    patch.nextRunAt === undefined
  ) {
    patch.nextRunAt = nextRunAtFor({ lastRunAt: existing.lastRunAt, intervalMinutes }, now);
  }
  // An owner edit ends an idle back-off: the loop is back on its plain interval. The stamp keeps a run in
  // flight from folding as idle and backing it off again.
  if (existing.status === 'live') patch.idleResetAt = now;
  if (existing.idleStreak) {
    patch.idleStreak = 0;
    if (!ticketsOnly && existing.status === 'live' && patch.nextRunAt === undefined) {
      patch.nextRunAt = nextRunAtFor(
        { lastRunAt: existing.lastRunAt, intervalMinutes: intervalMinutes ?? existing.intervalMinutes },
        now
      );
    }
  }

  const trial = existing.coachTrial;
  if (trial && by !== 'trial') {
    const next = {
      model: (patch.model as string | undefined) ?? existing.model,
      stageConfig: patch.stageConfig !== undefined ? (patch.stageConfig as ILoop['stageConfig']) : existing.stageConfig,
    };
    if (!stages.includes(trial.stage) || stageModelOf(next, trial.stage) !== stageModelOf(existing, trial.stage)) {
      patch.coachTrial = null;
    }
  }
  Object.assign(patch, extraPatch);

  // Conditional on the status the patch was computed from, so a scheduler write in between is not lost, and
  // on the stages stageConfig was checked against, so a concurrent stage edit can't leave orphan config.
  // A trial start is also conditional on no trial running, so two starts can't leave a stage on a trial model
  // with no trial record to revert it.
  const guard = {
    ...(patch.stageConfig !== undefined && { stages: existing.stages }),
    ...(extraPatch?.coachTrial ? { noTrial: true } : {}),
  };
  const updated = await loopRepository.updateForUser(
    id,
    userId,
    patch,
    existing.status,
    Object.keys(guard).length ? guard : undefined
  );
  if (!updated) throw new ConflictError('Loop changed while saving; reload and try again');
  if (patch.stages) await loopRepository.pruneTriggersForStages(userId, id, updated.stages);

  let eventId: string | undefined;
  const changed = changedVersionedFields(existing, updated);
  if (changed.length > 0 || reason) {
    const config: ILoopConfigChange = {
      by,
      before: Object.fromEntries(changed.map(field => [field, versioned(existing, field)])),
      after: Object.fromEntries(changed.map(field => [field, versioned(updated, field)])),
      ...(suggestionKey && { suggestionKey }),
    };
    // Best effort: the edit is saved; only its history entry (and undo) would be missing.
    eventId = await loopEventRepository
      .recordConfigChanged({
        loopId: id,
        userId,
        reason: reason || loopConfigChangeSummary(existing, updated) || 'settings changed',
        config,
        at: now,
      })
      .catch(error => {
        logger.warn('[Loops] Could not log a config change', { loopId: id, error });
        return undefined;
      });
  }

  if (updated.status === 'live') {
    const resumed = existing.status !== 'live';
    // A ticket made ready while it was paused runs now rather than an interval after the last run, as it would
    // have had the loop been live. A live tickets-mode loop only runs once a ticket makes it due, so it checks
    // on every edit.
    const madeDue = (resumed || updated.wakeMode === 'tickets') && (await makeDueIfReady(updated, now));
    if (madeDue) updated.nextRunAt = now;
    // Started or resumed: a no-op if its next run is not due yet.
    if (madeDue || resumed) await requestLoopDispatch(id, logger);
  }
  return { loop: updated, eventId };
}
