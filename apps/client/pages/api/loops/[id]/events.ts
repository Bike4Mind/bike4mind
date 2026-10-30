import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopDirectiveRepository, loopEventRepository, loopRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { directiveRow } from '@server/utils/loopDirectives';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';

/** Events returned per loop, newest first; older ones stay in the DB. */
export const LOOP_EVENT_LIMIT = 100;

/**
 * A loop's event log, newest first: unsure runs and how their owner answered, plus directives the loop sent
 * or received. Directives live in their own collection (LoopDirectiveModel) and are merged in here.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-events' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);

    const [events, directives] = await Promise.all([
      loopEventRepository.listForLoop(req.user!.id, loop.id, LOOP_EVENT_LIMIT),
      loopDirectiveRepository.listForLoop(req.user!.id, loop.id, LOOP_EVENT_LIMIT),
    ]);
    const rows = [
      ...events.map(event => ({
        id: event.id,
        kind: event.kind,
        executionId: event.executionId,
        workItemId: event.workItemId,
        ticketTitle: event.ticketTitle,
        iteration: event.iteration,
        confidence: event.confidence,
        reason: event.reason,
        resolution: event.resolution,
        createdAt: event.createdAt,
      })),
      ...directives.map(directiveRow),
    ];
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(rows.slice(0, LOOP_EVENT_LIMIT));
  });

export default handler;
