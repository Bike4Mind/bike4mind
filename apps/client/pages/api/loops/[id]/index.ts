import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  adminSettingsRepository,
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { ACTIVE_AGENT_EXECUTION_STATUSES, type ILoop, ILoopWithUsage, startOfUtcDay } from '@bike4mind/common';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { applyLoopConfigPatch, type LoopConfigBody } from '@server/utils/loopConfig';
import { STALE_ACTIVE_MS } from '@server/utils/executionLimits';

const notFound = (id: string) => new NotFoundError('Loop not found for id: ' + id);

/** Pausing stays open with EnableLoops off, so owners are never locked out of stopping a loop. */
const isPauseOnly = (body: unknown): boolean => {
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  return keys.length === 1 && keys[0] === 'status' && (body as { status?: unknown }).status === 'paused';
};

const WAITING_ON_CHILDREN: readonly string[] = ['awaiting_subagent', 'awaiting_dag_children'];

/**
 * Whether a run of the loop may still be working. Lanes the scheduler would fold (terminal or stale, as in
 * apps/workers/src/cron/loopScheduler.ts reconcileRun) do not count, nor does anything while EnableLoops is
 * off, since the scheduler then never folds them and the loop could not be deleted at all.
 */
async function hasLiveRuns(loop: ILoop, userId: string): Promise<boolean> {
  if ((await adminSettingsRepository.getSettingsValue('EnableLoops')) !== true) return false;
  const laneIds = loop.activeExecutionIds ?? [];
  const lanes = laneIds.length > 0 ? await agentExecutionRepository.find({ _id: { $in: laneIds } }) : [];
  const now = Date.now();
  const isLive = (run: (typeof lanes)[number]) =>
    ACTIVE_AGENT_EXECUTION_STATUSES.includes(run.status) &&
    (WAITING_ON_CHILDREN.includes(run.status) || now - new Date(run.updatedAt).getTime() < STALE_ACTIVE_MS);
  if (lanes.some(isLive)) return true;
  // None of the lanes is live, so their in-progress tickets are folded by the scheduler; any other is a desktop run.
  const tickets = await workItemRepository.listForLoop(userId, loop.id, 1);
  return tickets.some(
    ticket => ticket.status === 'in_progress' && !(ticket.executionId && laneIds.includes(ticket.executionId))
  );
}

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
    if (!isPauseOnly(req.body)) await assertLoopsEnabled();
    const id = String(req.query.id);
    const existing = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!existing) throw notFound(id);
    const { loop } = await applyLoopConfigPatch({
      existing,
      body: req.body as LoopConfigBody,
      userId: req.user!.id,
      logger: req.logger,
      by: 'owner',
    });
    res.json(loop);
  })
  .delete(async (req, res) => {
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw notFound(id);
    if (await hasLiveRuns(loop, req.user!.id)) {
      throw new ConflictError('The loop has runs in progress. Pause it and wait for them to finish, then delete it.');
    }
    // The notebook stays: it holds the loop's run history.
    if (!(await loopRepository.deleteForUser(id, req.user!.id))) throw notFound(id);
    await workItemRepository.softDeleteByLoop(req.user!.id, id);
    await loopEventRepository.deleteManyForLoop(req.user!.id, id);
    await loopDirectiveRepository.deleteManyForLoop(req.user!.id, id);
    await loopRepository.removeLoopReferences(req.user!.id, id);
    res.status(204).end();
  });

export default handler;
