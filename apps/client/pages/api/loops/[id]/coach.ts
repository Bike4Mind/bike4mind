import {
  B4MLLMToolsList,
  stageConfigOf,
  type ILoop,
  type ILoopCoachTrial,
  type IUserDocument,
  type LoopCoachResponse,
} from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { adminSettingsRepository, apiKeyRepository, loopEventRepository, loopRepository } from '@bike4mind/database';
import { isToolOfferable, resolveToolAvailability } from '@bike4mind/services/llm/toolAvailability';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getCallerModelList } from '@server/utils/callerModelList';
import { applyLoopConfigPatch, loopMatches, stageModelOf, type LoopConfigBody } from '@server/utils/loopConfig';
import { COACH, coachSuggestions, trialComparison } from '@server/utils/loopCoach';
import { readLoopStats } from '@server/utils/loopStats';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSIONS_SHOWN = 20;
const UNSURE_EVENTS = 500;
const DISMISSED_MAX = 50;
const DISMISS_REASON_MAX = 300;
const KEY_MAX = 300;
const DRIFTED = 'Settings changed since; edit the loop instead';

/** Everything the rules read, for one loop now. */
async function coachState(loop: ILoop, user: IUserDocument, logger: Logger, now: Date) {
  const windowStart = new Date(now.getTime() - COACH.windowDays * DAY_MS);
  const trialBaseline = loop.coachTrial
    ? new Date(new Date(loop.coachTrial.startedAt).getTime() - COACH.windowDays * DAY_MS)
    : undefined;
  const [{ stats, runs, tickets }, unsure, modelList, availability] = await Promise.all([
    readLoopStats(loop, user.id, COACH.windowDays, now, trialBaseline),
    loopEventRepository.listForLoopSince(user.id, loop.id, windowStart, ['unsure'], UNSURE_EVENTS),
    getCallerModelList(user, logger),
    resolveToolAvailability(
      user.id,
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } },
      {
        logger,
      }
    ),
  ]);
  const stageOfRun = new Map(runs.map(run => [run.id, run.loopStage]));
  const unsureReasons: Record<string, string[]> = {};
  for (const event of [...unsure].reverse()) {
    const stage = stageOfRun.get(event.executionId);
    if (!stage) continue;
    // Run text may hold anything; the evidence stays ASCII.
    const reason = event.reason.replace(/[^\x20-\x7e]/g, '?').slice(0, COACH.addStage.reasonChars);
    (unsureReasons[stage] ??= []).push(reason);
  }
  const suggestions = coachSuggestions({
    loop,
    stats,
    runs,
    tickets,
    unsureReasons,
    models: modelList.models,
    canAddTool: tool => (B4MLLMToolsList as string[]).includes(tool) && isToolOfferable(tool, availability),
    now,
  });
  return { suggestions, runs, tickets };
}

async function coachResponse(loop: ILoop, user: IUserDocument, logger: Logger, now: Date): Promise<LoopCoachResponse> {
  const [{ suggestions, runs, tickets }, changes] = await Promise.all([
    coachState(loop, user, logger, now),
    loopEventRepository.listConfigChanges(user.id, loop.id, VERSIONS_SHOWN),
  ]);
  const dismissedSince = now.getTime() - COACH.dismissDays * DAY_MS;
  // Undo is offered on the newest change that is still in force.
  const undoable = changes.find(
    event =>
      event.config &&
      event.config.by !== 'undo' &&
      !event.config.undoneBy &&
      Object.keys(event.config.after ?? {}).length > 0
  )?.id;
  const trial = loop.coachTrial;
  return {
    suggestions,
    dismissed: (loop.coachDismissed ?? [])
      .filter(entry => new Date(entry.at).getTime() >= dismissedSince)
      .map(entry => ({ key: entry.key, reason: entry.reason, at: new Date(entry.at).toISOString() })),
    ...(trial && {
      trial: {
        ...trial,
        startedAt: new Date(trial.startedAt).toISOString(),
        ...trialComparison(trial, runs, tickets),
      },
    }),
    versions: changes.map(event => ({
      id: event.id,
      at: new Date(event.createdAt).toISOString(),
      reason: event.reason,
      by: event.config?.by ?? 'owner',
      ...(event.config?.suggestionKey && { suggestionKey: event.config.suggestionKey }),
      undone: !!event.config?.undoneBy,
      undoable: event.id === undoable,
    })),
  };
}

const stringField = (body: Record<string, unknown>, field: string, max: number): string => {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${field} is required`);
  if (value.trim().length > max) throw new BadRequestError(`${field} must be ${max} characters or fewer`);
  return value.trim();
};

/**
 * The loop coach: GET lists rule-based suggestions (loopCoach.ts), the model trial, dismissals and recent settings
 * changes. POST applies one owner action. Apply and trial recompute the suggestion and use its own patch (a client
 * patch is ignored), and every settings write goes through applyLoopConfigPatch, like PATCH /api/loops/:id.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-coach' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    res.json(await coachResponse(loop, req.user!, req.logger, new Date()));
  })
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const user = req.user!;
    const loop = await loopRepository.findByIdAndUserId(id, user.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const now = new Date();
    const write = (input: Omit<Parameters<typeof applyLoopConfigPatch>[0], 'existing' | 'userId' | 'logger'>) =>
      applyLoopConfigPatch({ existing: loop, userId: user.id, logger: req.logger, ...input });
    const suggestion = async () => {
      const key = stringField(body, 'key', KEY_MAX);
      const found = (await coachState(loop, user, req.logger, now)).suggestions.find(item => item.key === key);
      if (!found?.patch) throw new NotFoundError('This suggestion no longer applies');
      if (found.disabledReason) throw new ConflictError(found.disabledReason);
      return { ...found, patch: found.patch };
    };

    switch (body.action) {
      case 'apply': {
        const { key, patch } = await suggestion();
        res.json((await write({ body: patch as LoopConfigBody, by: 'coach', suggestionKey: key })).loop);
        return;
      }
      case 'trial': {
        if (loop.coachTrial) throw new ConflictError('A trial is already running on this loop');
        const tickets = body.tickets ?? COACH.trial.default;
        if (
          typeof tickets !== 'number' ||
          !Number.isInteger(tickets) ||
          tickets < COACH.trial.min ||
          tickets > COACH.trial.max
        ) {
          throw new BadRequestError(`tickets must be an integer from ${COACH.trial.min} to ${COACH.trial.max}`);
        }
        const { key, patch, stage, trialable } = await suggestion();
        if (!trialable || !stage) throw new BadRequestError('This suggestion cannot be trialled');
        const model = stageConfigOf({ stageConfig: patch.stageConfig as ILoop['stageConfig'] }, stage).model!;
        const previousModel = stageConfigOf(loop, stage).model;
        const coachTrial: ILoopCoachTrial = {
          stage,
          model,
          ...(previousModel && { previousModel }),
          baselineModel: stageModelOf(loop, stage),
          tickets,
          startedAt: now,
        };
        res.json(
          (await write({ body: patch as LoopConfigBody, by: 'trial', suggestionKey: key, extraPatch: { coachTrial } }))
            .loop
        );
        return;
      }
      case 'keep': {
        const trial = loop.coachTrial;
        if (!trial) throw new ConflictError('No trial is running');
        const reason = `trial kept: ${trial.stage} stays on ${trial.model}`.replace(/[^\x20-\x7e]/g, '?');
        res.json((await write({ body: {}, by: 'trial', extraPatch: { coachTrial: null }, reason })).loop);
        return;
      }
      case 'revert': {
        const trial = loop.coachTrial;
        if (!trial) throw new ConflictError('No trial is running');
        if (!loop.stages.includes(trial.stage) || stageModelOf(loop, trial.stage) !== trial.model) {
          throw new ConflictError(DRIFTED);
        }
        const stageConfig = (loop.stageConfig ?? []).map(entry => {
          if (entry.stage !== trial.stage) return entry;
          const { model: _trialModel, ...rest } = entry;
          return trial.previousModel ? { ...rest, model: trial.previousModel } : rest;
        });
        res.json((await write({ body: { stageConfig }, by: 'trial', extraPatch: { coachTrial: null } })).loop);
        return;
      }
      case 'undo': {
        const event = await loopEventRepository.findConfigChange(
          stringField(body, 'eventId', KEY_MAX),
          user.id,
          loop.id
        );
        if (!event?.config) throw new NotFoundError('Change not found');
        const { by, undoneBy, before = {}, after = {} } = event.config;
        if (by === 'undo' || undoneBy || Object.keys(after).length === 0) {
          throw new BadRequestError('This change cannot be undone');
        }
        if (!loopMatches(loop, after)) throw new ConflictError(DRIFTED);
        const { loop: updated, eventId } = await write({ body: before as LoopConfigBody, by: 'undo' });
        if (eventId) await loopEventRepository.markConfigUndone(event.id, eventId);
        res.json(updated);
        return;
      }
      case 'dismiss': {
        const key = stringField(body, 'key', KEY_MAX);
        const reason = stringField(body, 'reason', DISMISS_REASON_MAX);
        const coachDismissed = [
          ...(loop.coachDismissed ?? []).filter(entry => entry.key !== key),
          { key, reason, at: now },
        ].slice(-DISMISSED_MAX);
        res.json(await loopRepository.updateForUser(loop.id, user.id, { coachDismissed }));
        return;
      }
      case 'restore': {
        const key = stringField(body, 'key', KEY_MAX);
        const rest = (loop.coachDismissed ?? []).filter(entry => entry.key !== key);
        res.json(await loopRepository.updateForUser(loop.id, user.id, { coachDismissed: rest.length ? rest : null }));
        return;
      }
      default:
        throw new BadRequestError('action must be one of: apply, trial, keep, revert, undo, dismiss, restore');
    }
  });

export default handler;
