import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { agentExecutionRepository, userRepository } from '@bike4mind/database';
import { ILoopsBudget, startOfUtcDay } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { loopLaneLimits, userLoopsDailyCap } from '@server/utils/loopBudget';
import {
  assertLoopsEnabled,
  LOOP_RATE_LIMIT,
  LOOP_RATE_WINDOW_MS,
  validateLoopBudget,
} from '@server/utils/loopValidation';

async function budgetFor(userId: string): Promise<ILoopsBudget> {
  const [cap, creditsToday, laneLimits] = await Promise.all([
    userLoopsDailyCap(userId),
    agentExecutionRepository.sumLoopCreditsForUser(userId, startOfUtcDay(new Date())),
    loopLaneLimits(),
  ]);
  return {
    creditsToday,
    userDailyCredits: cap.user,
    adminDailyCredits: cap.admin,
    effectiveCap: cap.effective,
    laneLimits,
  };
}

/** The caller's all-loops daily budget: today's spend across their loops, and their own cap (PUT; null clears). */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-budget' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    res.json(await budgetFor(req.user!.id));
  })
  .put(async (req, res) => {
    await assertLoopsEnabled();
    const value = (req.body as { dailyCredits?: unknown } | undefined)?.dailyCredits;
    if (value === undefined) throw new BadRequestError('dailyCredits is required (null clears it)');
    await userRepository.setLoopsDailyCredits(req.user!.id, value === null ? null : validateLoopBudget(value));
    res.json(await budgetFor(req.user!.id));
  });

export default handler;
