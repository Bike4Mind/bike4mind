import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import {
  completeRunnerRun,
  heartbeatRunnerRun,
  isRefusal,
  progressRunnerRun,
  type RunnerRefusal,
} from '@server/utils/loopRunner';

const TEXT_MAX = 4000;
const text = z.string().max(TEXT_MAX);
const durationMs = z.number().int().min(0);

const ProgressBody = z.object({
  frames: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text }),
        z.object({ type: z.literal('tool-start'), callId: text, name: text, input: text }),
        z.object({
          type: z.literal('tool-end'),
          callId: text,
          name: text,
          status: text,
          error: text.optional(),
          preview: text.optional(),
        }),
        z.object({ type: z.literal('usage'), usage: z.unknown() }),
      ])
    )
    .max(200),
});

const reason = z.string().min(1).max(1000);
const CompleteBody = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('advanced'), answer: z.string().max(100_000), durationMs }),
  z.object({ outcome: z.literal('blocked'), reason, answer: z.string().max(100_000).optional(), durationMs }),
  z.object({ outcome: z.literal('failed'), reason, durationMs }),
  z.object({ outcome: z.literal('released'), reason: reason.optional(), durationMs }),
]);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
  return parsed.data;
}

/**
 * A desktop run's heartbeat, progress and complete calls (server/utils/loopRunner.ts). 410 `{ error, reason }`
 * means the lease or the run is gone. Rate-limited above the runner's flush cadence (about 1/s per lane).
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 600, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-runner-run' }))
  .post(async (req, res) => {
    await assertLoopsEnabled();
    const userId = req.user!.id;
    const runId = String(req.query.runId);
    const now = new Date();
    let result: object | RunnerRefusal;
    switch (req.query.action) {
      case 'heartbeat':
        result = await heartbeatRunnerRun(userId, runId, now, req.logger);
        break;
      case 'progress':
        result = await progressRunnerRun(userId, runId, parse(ProgressBody, req.body).frames, now, req.logger);
        break;
      case 'complete':
        result = await completeRunnerRun(userId, runId, parse(CompleteBody, req.body), now, req.logger);
        break;
      default:
        throw new NotFoundError('Not found');
    }
    if (isRefusal(result)) return res.status(result.status).json({ error: result.error, reason: result.reason });
    res.json(result);
  });

// The contract's body cap; the per-frame limits alone would allow more, so the runner flushes small batches.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

export default handler;
