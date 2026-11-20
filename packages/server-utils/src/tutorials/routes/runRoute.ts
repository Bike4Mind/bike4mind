import { z } from 'zod';
import { rateLimit } from '../../middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '../../utils/userRateTier';
import type { TutorialRequest } from './types';
import { TUTORIAL_MODULE_STATUSES } from '../models';
import type { TutorialService } from '../service';
import type { ApiBuilder, Gate } from './types';

// One walk through a module makes a dozen cheap calls inside a minute, and a new account sits on the
// free tier, which allows ten.
const RUN_FLOOR_PER_MIN = 60;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const ID = z.string().min(1).max(64);

export const TutorialRunRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('progress') }),
  z.object({ action: z.literal('modules') }),
  z.object({ action: z.literal('start'), moduleId: ID }),
  z.object({ action: z.literal('resume'), moduleId: ID }),
  z.object({ action: z.literal('sheet'), moduleId: ID }),
  z.object({
    action: z.literal('advance'),
    moduleId: ID,
    sessionId: z.string().regex(OBJECT_ID),
    turn: z.number().int().min(0).max(1000),
  }),
  z.object({
    action: z.literal('position'),
    moduleId: ID,
    stepId: ID,
    status: z.enum(TUTORIAL_MODULE_STATUSES),
    version: z.number().int().min(0).optional(),
    revision: z.number().int().min(0).optional(),
  }),
]);

export interface RunRouteOptions {
  api: ApiBuilder;
  /** Runs before anything else, in order: the owner's switch, its access checks. */
  gates: readonly Gate[];
  /** Rate-limit bucket name, one per owner. */
  bucket: string;
  /**
   * The service over the modules this caller may run. A module left out answers like an unknown id, so
   * the access rule lives in what this returns and no action can forget it.
   */
  serviceFor: (req: TutorialRequest) => Promise<TutorialService>;
}

/**
 * The guided tutorial's server half, one route and seven actions: `modules` lists the enabled modules as
 * the page runs them, overrides applied; `start` (also restart) opens a fresh session and files the module's
 * sheet; `resume` reopens the module in the session it already has; `sheet` names that file; `advance`
 * inserts a recorded quest when the journey panel jumps ahead; `position` records the step; `progress` reads
 * where the user stands. The user's own messages are answered in the chat path.
 */
export function runRoute({ api, gates, bucket, serviceFor }: RunRouteOptions) {
  const router = api();
  for (const gate of gates) router.use(gate);
  return router
    .use(
      rateLimit({
        // rateLimit types its callback with plain Express; baseApi has attached the user by now.
        limit: async req =>
          Math.max(await resolveUserRateLimitPerMin((req as TutorialRequest).user), RUN_FLOOR_PER_MIN),
        windowMs: 60 * 1000,
        bucket,
      })
    )
    .post(async (req, res) => {
      const parsed = TutorialRunRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

      const userId = req.user!.id;
      const service = await serviceFor(req);
      const body = parsed.data;
      if (body.action === 'progress') return res.json(await service.progress(userId));
      if (body.action === 'modules') return res.json({ modules: service.modules() });

      const result =
        body.action === 'start'
          ? await service.start(userId, body.moduleId)
          : body.action === 'resume'
            ? await service.resume(userId, body.moduleId)
            : body.action === 'sheet'
              ? await service.sheet(userId, body.moduleId)
              : body.action === 'advance'
                ? await service.advance(userId, body)
                : await service.position(userId, body);
      if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
      const { ok: _ok, ...rest } = result;
      return res.json(rest);
    });
}
