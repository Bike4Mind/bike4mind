import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository, workItemRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { LOOP_TICKET_CLOSED_WINDOW } from '@server/utils/loopTickets';

/** A loop's tickets grouped by stage, in the loop's stage order. A ticket in a stage the loop no longer has lists under the first stage. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: LOOP_RATE_LIMIT, windowMs: LOOP_RATE_WINDOW_MS, bucket: 'loops-tickets' }))
  .get(async (req, res) => {
    await assertLoopsEnabled();
    const id = String(req.query.id);
    const loop = await loopRepository.findByIdAndUserId(id, req.user!.id);
    if (!loop) throw new NotFoundError('Loop not found for id: ' + id);

    const tickets = await workItemRepository.listForLoop(req.user!.id, loop.id, LOOP_TICKET_CLOSED_WINDOW);
    const deps = await workItemRepository.findManyByIdsForUser(
      [...new Set(tickets.flatMap(ticket => ticket.dependencies))],
      req.user!.id
    );
    const openDeps = new Set(deps.filter(dep => dep.status !== 'closed').map(dep => dep.id));

    const groups = new Map(loop.stages.map(stage => [stage, [] as unknown[]]));
    for (const ticket of tickets) {
      const group = groups.get(ticket.stage ?? '') ?? groups.get(loop.stages[0]);
      group?.push({
        id: ticket.id,
        title: ticket.title,
        description: ticket.description,
        stage: ticket.stage,
        status: ticket.status,
        statusReason: ticket.statusReason,
        dependencies: ticket.dependencies,
        executionId: ticket.executionId,
        ready: ticket.status === 'open' && ticket.dependencies.every(depId => !openDeps.has(depId)),
        updatedAt: ticket.updatedAt,
      });
    }

    res.json({ stages: Array.from(groups, ([stage, stageTickets]) => ({ stage, tickets: stageTickets })) });
  });

export default handler;
