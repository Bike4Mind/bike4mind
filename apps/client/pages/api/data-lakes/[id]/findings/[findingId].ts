import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeFindingRepository } from '@bike4mind/database';
import { LAKE_FINDING_RESOLUTION_MAX_CHARS, type LakeFindingTerminalStatus } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { loadFindingForLake } from '@server/dataLakes/loadFindingForLake';
import { recordFindingResolutionBelief } from '@server/dataLakes/recordFindingResolutionBelief';

/**
 * The two state changes a curator can make, as a discriminated union rather than a partial patch:
 * resolving and assigning have different guards (one is a once-only terminal transition, the other
 * is idempotent and legal in any status), so a body that could carry both would have to answer what
 * happens when one half succeeds and the other does not.
 *
 * `resolve` and `dismiss` mirror the proposal queue's `approve` / `decline` - the action IS the
 * terminal status, so there is no way to send an action and a contradicting status.
 */
const UpdateBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve'),
    resolution: z.string().trim().max(LAKE_FINDING_RESOLUTION_MAX_CHARS).optional(),
  }),
  z.object({
    action: z.literal('dismiss'),
    resolution: z.string().trim().max(LAKE_FINDING_RESOLUTION_MAX_CHARS).optional(),
  }),
  z.object({
    // Null clears the assignment. Explicitly nullable rather than optional so "unassign" is a thing
    // a caller can say, instead of being indistinguishable from "leave it alone".
    action: z.literal('assign'),
    assigneeUserId: z.string().trim().min(1).nullable(),
  }),
]);

/**
 * POST /api/data-lakes/:id/findings/:findingId - rule on one detected corpus problem (#3039).
 *
 * DETECT, DO NOT REJECT (#2242). Resolving or dismissing a finding records a HUMAN'S JUDGEMENT and
 * mutates nothing else: no document is removed, re-chunked, re-ingested or gated as a result. If a
 * later issue wants a resolution to change a corpus, that has to be argued on its own merits - it
 * is not something this route may be quietly widened into. Corpus change gets a door of its own (#3046).
 *
 * A resolution carrying a note is ALSO projected into the lake's memory as a belief (#3049), which
 * is inside that guardrail rather than an exception to it: the corpus is untouched, and what gets
 * written is the curator's own sentence about it. Best-effort and last, after the row is committed -
 * see `recordFindingResolutionBelief` for why the ruling must never depend on the memory write.
 *
 * MANAGE-gated via `assertLakeWriteAccess`, matching the list route and `inconsistencies.ts`.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    // Before the first await: the crypto-shred fence refuses a write only when the purge lands at or
    // after this instant, so stamping it later would let a purge that landed mid-request lift its own
    // tombstone. See `recordFindingResolutionBelief`'s `startedAt`.
    const startedAt = new Date();
    const { id, findingId } = req.query as { id: string; findingId: string };

    // Scope, lake-write access and belongs-to-lake, shared with the `/belief` sibling. The
    // cross-lake check is what stops a caller who manages one lake from ruling on any finding id in
    // the database by quoting their own lake in the URL.
    //
    // The mutations below ALSO carry `lake.id` as a filter term, so the rule holds without the
    // finding read. It stays because the two answer different questions: the filter refuses the
    // write, this decides the STATUS - without it a cross-lake id and an already-resolved one both
    // come back as the same null, and the 404/400 split below could not tell them apart without
    // leaking which.
    const { lake, ctx } = await loadFindingForLake(req, { lakeId: id, findingId });

    // AFTER the gates, deliberately: an unauthorized caller learns nothing about their own payload,
    // and by the time a 400 is reachable the caller has already proven they manage this lake.
    const body = UpdateBody.parse(req.body);

    if (body.action === 'assign') {
      // Shape-validated only. Whether the assignee can actually MANAGE this lake is deliberately not
      // checked here: answering it needs the assignee's own org membership resolved into an
      // AccessContext, which is a different read than this route holds, and half-checking it (does
      // the user row exist?) would assure a caller of something it had not established. The picker
      // that produces this id is #3044/#3045; a dead assignment is visible and reversible, and no
      // assignment grants any access on its own.
      const assigned = await dataLakeFindingRepository.assignFinding(lake.id, findingId, body.assigneeUserId);
      if (!assigned) throw new NotFoundError('Finding not found');
      return res.json({ data: assigned });
    }

    const status: LakeFindingTerminalStatus = body.action === 'resolve' ? 'resolved' : 'dismissed';
    const resolved = await dataLakeFindingRepository.resolveFinding(lake.id, findingId, {
      status,
      resolvedByUserId: ctx.userId,
      resolvedAt: new Date(),
      resolution: body.resolution,
    });
    // Null means the CAS filter matched nothing, which is two different things: the row is still
    // there but no longer open (the double-resolve guard firing on a race or a double-click), or it
    // was deleted between the read above and this write - a lake teardown and a source purge both
    // sweep findings, so that is a real interleaving and not a theoretical one. Re-read to tell
    // them apart rather than reporting a row that no longer exists as "already ruled on"; the
    // `assign` branch above already 404s that same case, and this is what makes the two agree.
    if (!resolved) {
      const stillPresent = await dataLakeFindingRepository.findById(findingId);
      if (!stillPresent) throw new NotFoundError('Finding not found');
      throw new BadRequestError('This finding has already been ruled on');
    }

    // The ruling is committed; this projects it into lake memory so the next session inherits it.
    // Deliberately AFTER the write and deliberately swallowing: `recordFindingResolutionBelief` does
    // not throw on a memory-subsystem failure, and the `catch` is the backstop for the unforeseen
    // (an import-time fault, a repository that throws outside its own guard). Failing the request
    // here would report a resolution that is already durably recorded as not having happened, and
    // the retry would 400 on the double-resolve guard.
    const belief = await recordFindingResolutionBelief(
      // `resolved.resolution` rather than `body.resolution`: the belief must quote what was
      // actually COMMITTED, and the repository normalizes an absent note to null on the way in.
      // Same source the standalone belief route reads, so the two cannot drift.
      { lake, finding: resolved, status, resolution: resolved.resolution, startedAt },
      { logger: req.logger }
    ).catch((err: unknown) => {
      req.logger.warn('[lakeMemory] could not record the curator resolution as a belief', {
        dataLakeId: lake.id,
        findingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    // Reported rather than silent, so a curator who wrote a note can see whether it reached memory.
    // The REASON rides along additively, in the same shape the `/belief` sibling returns, because a
    // bare false cannot tell "lake memory is off" from "you left the note empty" - and those are
    // opposite things to show a curator. Absent on success and on the unforeseen-throw path above,
    // where there is no reason to report.
    const beliefReason = belief && !belief.recorded ? { beliefSkipReason: belief.reason } : {};
    return res.json({ data: resolved, beliefRecorded: belief?.recorded ?? false, ...beliefReason });
  });

export const config = { api: { externalResolver: true } };

export default handler;
