import { desktopStagesOf, RUNNER_PRESENCE_FRESH_MS } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { loopRepository, loopRunnerPresenceRepository, workItemRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { assertLoopsEnabled, LOOP_RATE_LIMIT, LOOP_RATE_WINDOW_MS } from '@server/utils/loopValidation';
import { LOOP_TICKET_CLOSED_WINDOW, ticketRunLimit } from '@server/utils/loopTickets';

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

    // A desktop-stage ticket is never picked by a cloud run, so it is not queued here.
    const desktopStages = new Set(desktopStagesOf(loop));
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
        runCount: ticket.runCount ?? 0,
        ready:
          ticket.status === 'open' &&
          !desktopStages.has(ticket.stage ?? '') &&
          ticket.dependencies.every(depId => !openDeps.has(depId)),
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      });
    }

    // The owner's desktop runner, for the waiting text on desktop-stage tickets; null without a desktop stage.
    const presence = desktopStages.size > 0 ? await loopRunnerPresenceRepository.findByUserId(req.user!.id) : null;
    const runner =
      desktopStages.size === 0
        ? null
        : {
            online: !!presence && Date.now() - new Date(presence.seenAt).getTime() < RUNNER_PRESENCE_FRESH_MS,
            lanesFree: presence?.lanesFree ?? 0,
            ...(presence?.waitingReason && { waitingReason: presence.waitingReason }),
          };

    res.json({
      stages: Array.from(groups, ([stage, stageTickets]) => ({ stage, tickets: stageTickets })),
      runLimit: ticketRunLimit(loop.stages),
      runner,
    });
  });

export default handler;
