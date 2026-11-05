import type { ILoop } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository } from '@bike4mind/database';
import { ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { loopAdmission, MAX_ACTIVE_LOOP_RUNS } from '@server/utils/loopBudget';
import { requestLoopDispatch } from '@server/utils/loopDispatch';

/**
 * Why a Run now cannot start right away, from a read-only pre-check of what the dispatcher will refuse on;
 * undefined when it should start within seconds. Advisory: the dispatch itself decides.
 */
async function runNowWaitingReason(loop: ILoop, now: Date): Promise<string | undefined> {
  if (loop.activeExecutionId) return 'Already running; the next run starts when this one ends';
  if ((await loopRepository.countInFlight()) >= MAX_ACTIVE_LOOP_RUNS) {
    return 'All run slots are busy; it starts when one frees up';
  }
  const admission = await loopAdmission(loop, loop.model, now);
  if (admission.ok) return undefined;
  switch (admission.kind) {
    case 'credits':
      return 'Not enough credits to start a run';
    case 'loop_budget':
      return "This loop's daily budget is spent; it resumes 00:00 UTC";
    case 'user_budget':
      return 'Your all-loops daily budget is spent; loops resume 00:00 UTC';
    case 'paced':
      return `Paced to spread the daily budget; next run at ${admission.readyAt.toISOString().slice(11, 16)} UTC`;
  }
}

/**
 * Run now: makes the loop due and asks for an immediate dispatch (requestLoopDispatch), so it starts within
 * seconds when a run slot and its budget allow. It does not dispatch inline - the dispatcher's claim is what
 * keeps runs from overlapping. The response adds `waitingReason` when the run cannot start yet.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-run' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);
    if (loop.status !== 'live') throw new ConflictError('Only a live loop can be run; set it live first');

    const now = new Date();
    const updated = await loopRepository.updateForUser(
      id,
      req.user!.id,
      { nextRunAt: now, idleStreak: 0, idleResetAt: now },
      'live'
    );
    if (!updated) throw new ConflictError('Only a live loop can be run; set it live first');
    const waitingReason = await runNowWaitingReason(updated, now);
    await requestLoopDispatch(id, req.logger);
    res.json({ ...updated, ...(waitingReason && { waitingReason }) });
  });

export default handler;
