import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { ILoop, ILoopStageConfig, ILoopWithUsage, startOfUtcDay } from '@bike4mind/common';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { requestLoopDispatch } from '@server/utils/loopDispatch';
import { makeDueIfReady } from '@server/utils/loopTickets';
import { loopConfigChangeSummary } from '@server/utils/loopConfigSummary';
import {
  assertLoopsEnabled,
  LOOP_RATE_LIMIT,
  LOOP_RATE_WINDOW_MS,
  nextRunAtFor,
  nextStatusPatch,
  pruneOwnTriggers,
  pruneStageConfig,
  validateLoopAgentId,
  validateLoopAgentsAndSkills,
  validateLoopBudget,
  validateLoopMaxConcurrent,
  validateLoopGoal,
  validateLoopHandoffTargets,
  validateLoopInterval,
  validateLoopModel,
  validateLoopName,
  validateLoopOversees,
  validateLoopPriorityPolicy,
  validateLoopSlackChannel,
  validateLoopStageConfig,
  validateLoopStages,
  validateLoopTools,
  validateLoopTriggers,
  validateLoopWakeMode,
} from '@server/utils/loopValidation';

const notFound = (id: string) => new NotFoundError('Loop not found for id: ' + id);

const handler = baseApi({ auth: 'jwtOnly' })
  // Explicit bucket: the raw pathname embeds the loop id, which would make the limit per-loop.
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-item' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw notFound(id);
    const [credits, creditsToday, blocked] = await Promise.all([
      agentExecutionRepository.sumCreditsByLoop([loop.id], [loop.sessionId]),
      agentExecutionRepository.sumCreditsByLoop([loop.id], [loop.sessionId], startOfUtcDay(new Date())),
      workItemRepository.countBlockedByLoop(req.user!.id, [loop.id]),
    ]);
    res.json({
      ...loop,
      creditsUsed: credits[loop.id] ?? 0,
      creditsToday: creditsToday[loop.id] ?? 0,
      blockedTickets: blocked[loop.id] ?? 0,
    } satisfies ILoopWithUsage);
  })
  .patch(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    // These fields are widened to allow the explicit null that clears them.
    const body = req.body as Partial<
      Omit<
        ILoop,
        | 'agentId'
        | 'budgetCreditsPerDay'
        | 'maxConcurrent'
        | 'oversees'
        | 'handoffTargets'
        | 'triggers'
        | 'wakeMode'
        | 'slackChannelId'
      >
    > & {
      agentId?: string | null;
      budgetCreditsPerDay?: number | null;
      maxConcurrent?: number | null;
      oversees?: string[] | null;
      handoffTargets?: string[] | null;
      triggers?: unknown;
      wakeMode?: string | null;
      slackChannelId?: string | null;
    };

    const existing = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!existing) throw notFound(id);

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
      patch.budgetCreditsPerDay =
        body.budgetCreditsPerDay === null ? null : validateLoopBudget(body.budgetCreditsPerDay);
    }
    if (body.maxConcurrent !== undefined) {
      patch.maxConcurrent = body.maxConcurrent === null ? null : validateLoopMaxConcurrent(body.maxConcurrent);
    }
    if (body.oversees !== undefined) {
      patch.oversees = await validateLoopOversees(body.oversees, existing.id, req.user!.id);
    }
    if (body.handoffTargets !== undefined) {
      patch.handoffTargets = await validateLoopHandoffTargets(body.handoffTargets, existing.id, req.user!.id);
    }
    if (body.triggers !== undefined) {
      patch.triggers = await validateLoopTriggers(body.triggers, existing.id, req.user!.id, stages);
    } else if (patch.stages && existing.triggers?.length) {
      patch.triggers = pruneOwnTriggers(existing.triggers, stages);
    }
    if (body.wakeMode !== undefined) patch.wakeMode = validateLoopWakeMode(body.wakeMode);
    // Unchanged (the form re-sends it) is not re-authorised: a later opt-out must not block unrelated edits; the
    // post re-checks it anyway.
    if (body.slackChannelId !== undefined && body.slackChannelId !== existing.slackChannelId) {
      patch.slackChannelId = await validateLoopSlackChannel(body.slackChannelId, existing.organizationId, req.user!.id);
    }
    // Only new or changed agents and skills are checked, as with slackChannelId: one deleted or unshared since
    // the last save must not block unrelated edits (its run skips it).
    const changedAgentId = patch.agentId && patch.agentId !== existing.agentId ? (patch.agentId as string) : undefined;
    const changedStageConfig = ((patch.stageConfig as ILoopStageConfig[] | null | undefined) ?? []).map(config => {
      const before = existing.stageConfig?.find(prior => prior.stage === config.stage);
      return {
        stage: config.stage,
        agentId: config.agentId !== before?.agentId ? config.agentId : undefined,
        skills: config.skills?.filter(skill => !before?.skills?.includes(skill)),
      };
    });
    await validateLoopAgentsAndSkills(
      { userId: req.user!.id, organizationId: existing.organizationId },
      changedAgentId,
      changedStageConfig
    );
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

    // Conditional on the status the patch was computed from, so a scheduler write in between is not lost, and
    // on the stages stageConfig was checked against, so a concurrent stage edit can't leave orphan config.
    const guard = patch.stageConfig !== undefined ? { stages: existing.stages } : undefined;
    const updated = await loopRepository.updateForUser(id, req.user!.id, patch, existing.status, guard);
    if (!updated) throw new ConflictError('Loop changed while saving; reload and try again');
    if (patch.stages) await loopRepository.pruneTriggersForStages(req.user!.id, id, updated.stages);
    const changed = loopConfigChangeSummary(existing, updated);
    if (changed) {
      // Best effort: the edit is saved; only the stats' era marker would be missing.
      await loopEventRepository
        .recordConfigChanged({ loopId: id, userId: req.user!.id, reason: changed, at: now })
        .catch(error => req.logger.warn('[Loops] Could not log a config change', { loopId: id, error }));
    }
    if (updated.status === 'live') {
      const resumed = existing.status !== 'live';
      // A ticket made ready while it was paused runs now rather than an interval after the last run, as it would
      // have had the loop been live. A live tickets-mode loop only runs once a ticket makes it due, so it checks
      // on every edit.
      const madeDue = (resumed || updated.wakeMode === 'tickets') && (await makeDueIfReady(updated, now));
      if (madeDue) updated.nextRunAt = now;
      // Started or resumed: a no-op if its next run is not due yet.
      if (madeDue || resumed) await requestLoopDispatch(id, req.logger);
    }
    res.json(updated);
  })
  .delete(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    // The notebook stays: it holds the loop's run history.
    if (!(await loopRepository.deleteForUser(id, req.user!.id))) throw notFound(id);
    await workItemRepository.softDeleteByLoop(req.user!.id, id);
    await loopEventRepository.deleteManyForLoop(req.user!.id, id);
    await loopDirectiveRepository.deleteManyForLoop(req.user!.id, id);
    await loopRepository.removeLoopReferences(req.user!.id, id);
    res.status(204).end();
  });

export default handler;
