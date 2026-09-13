import { Quest } from '@bike4mind/database';
import { rollDice } from '@server/managers/dice';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { assertSessionAccess } from '@server/utils/sessionAccess';
import { z } from 'zod';

const RollRequestSchema = z.object({
  diceSpec: z.string(),
  sessionId: z.string(),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: 10, // 10 req/min
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const now = new Date();

    const { diceSpec, sessionId } = RollRequestSchema.parse(req.body);
    req.logger.debug(`[DICE] Processing roll request: ${diceSpec} for session ${sessionId}`);

    await assertSessionAccess(sessionId, req.user!.id, 'write', req.user!.groups ?? []);

    const roll: number = rollDice(diceSpec);
    req.logger.debug(`[DICE] Roll result: ${roll}`);

    const quest = await Quest.create({
      sessionId,
      prompt: diceSpec,
      type: 'message',
      timestamp: now,
      replies: ['You rolled a ' + roll],
    });

    const eventDetail = {
      diceSpec,
      roll,
      sessionId,
      timestamp: now.toISOString(),
    };

    req.logger.debug(`[DICE] Event detail: ${JSON.stringify(eventDetail)}`);

    return res.json(quest);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
