import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository } from '@bike4mind/database';
import { ILoop } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import {
  assertLoopsEnabled,
  LOOP_RATE_LIMIT,
  LOOP_RATE_WINDOW_MS,
  nextStatusPatch,
  validateLoopAgentId,
  validateLoopBudget,
  validateLoopGoal,
  validateLoopInterval,
  validateLoopModel,
  validateLoopName,
  validateLoopStages,
  validateLoopTools,
} from '@server/utils/loopValidation';

const notFound = (id: string) => new NotFoundError('Loop not found for id: ' + id);

const handler = baseApi()
  // Explicit bucket: the raw pathname embeds the loop id, which would make the limit per-loop.
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-item' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw notFound(id);
    res.json(loop);
  })
  .patch(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    // agentId and budgetCreditsPerDay are widened to allow the explicit null that clears them.
    const body = req.body as Partial<Omit<ILoop, 'agentId' | 'budgetCreditsPerDay'>> & {
      agentId?: string | null;
      budgetCreditsPerDay?: number | null;
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
    if (body.agentId !== undefined) patch.agentId = body.agentId === null ? null : validateLoopAgentId(body.agentId);
    if (body.budgetCreditsPerDay !== undefined) {
      patch.budgetCreditsPerDay =
        body.budgetCreditsPerDay === null ? null : validateLoopBudget(body.budgetCreditsPerDay);
    }
    if (body.status !== undefined) Object.assign(patch, nextStatusPatch(existing, body.status, new Date()));

    const updated = await loopRepository.updateForUser(id, req.user!.id, patch);
    if (!updated) throw notFound(id);
    res.json(updated);
  })
  .delete(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    // The notebook stays: it holds the loop's run history.
    if (!(await loopRepository.deleteForUser(id, req.user!.id))) throw notFound(id);
    res.status(204).end();
  });

export default handler;
