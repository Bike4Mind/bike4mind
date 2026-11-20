import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { activeLaneCount, ILoopWithUsage, startOfUtcDay } from '@bike4mind/common';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { applyLoopConfigPatch, type LoopConfigBody } from '@server/utils/loopConfig';

const notFound = (id: string) => new NotFoundError('Loop not found for id: ' + id);

/** Pausing stays open with EnableLoops off, so owners are never locked out of stopping a loop. */
const isPauseOnly = (body: unknown): boolean => {
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  return keys.length === 1 && keys[0] === 'status' && (body as { status?: unknown }).status === 'paused';
};

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
    const tickets = await workItemRepository.listForLoop(req.user!.id, id, 1);
    if (activeLaneCount(loop) > 0 || tickets.some(ticket => ticket.status === 'in_progress')) {
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
