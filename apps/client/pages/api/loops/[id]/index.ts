import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopEventRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import { ILoopWithUsage, startOfUtcDay } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { applyLoopConfigPatch, type LoopConfigBody } from '@server/utils/loopConfig';

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
