import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopMirrorRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { LOOP_MIRROR_LOOPS_MAX, loopMirrorSnapshotSchema } from '@bike4mind/common/loops';
import { assertLoopsEnabled } from '@server/utils/loopValidation';

const LocalLoopId = z.string().uuid();

function localLoopIdOf(query: unknown): string {
  const id = LocalLoopId.safeParse((query as { localLoopId?: unknown }).localLoopId);
  if (!id.success) throw new BadRequestError('Invalid loop id');
  return id.data;
}

/**
 * The caller's Desktop posting one of its loops' status (PUT) or taking it down (DELETE): a read-only snapshot for
 * the web Loops page. The snapshot schema is strict, so anything beyond the listed status fields is refused.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  // A heartbeat every 2 min per mirrored loop plus debounced changes; generous for 50 loops.
  .use(rateLimit({ limit: 240, windowMs: 60_000, bucket: 'loops-mirror' }))
  .put(async (req, res) => {
    await assertLoopsEnabled();
    const userId = req.user!.id;
    const localLoopId = localLoopIdOf(req.query);
    const body = loopMirrorSnapshotSchema.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.issues[0]?.message || 'Invalid request body');
    if (
      !(await loopMirrorRepository.exists(userId, localLoopId)) &&
      (await loopMirrorRepository.countForUser(userId)) >= LOOP_MIRROR_LOOPS_MAX
    )
      throw new BadRequestError(`At most ${LOOP_MIRROR_LOOPS_MAX} Desktop loops are shown on the web`);
    await loopMirrorRepository.upsert(userId, localLoopId, body.data, new Date());
    res.json({ ok: true });
  })
  .delete(async (req, res) => {
    await assertLoopsEnabled();
    await loopMirrorRepository.remove(req.user!.id, localLoopIdOf(req.query));
    res.json({ ok: true });
  });

export default handler;
