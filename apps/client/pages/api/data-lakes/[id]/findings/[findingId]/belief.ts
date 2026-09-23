import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { BadRequestError } from '@bike4mind/utils';
import { Request } from 'express';
import { loadFindingForLake } from '@server/dataLakes/loadFindingForLake';
import { recordFindingResolutionBelief } from '@server/dataLakes/recordFindingResolutionBelief';

/**
 * POST /api/data-lakes/:id/findings/:findingId/belief - persist a finding's curator resolution into
 * the lake's memory, so the next session does not repeat the confusion a human already settled (#3049).
 *
 * TAKES NO BODY, deliberately. The belief is composed from the resolution ALREADY STORED on the
 * finding, so there is no way to record a belief that says something other than what the curator
 * actually ruled - the finding row stays the single account of the decision, and this is only its
 * projection into memory. That also makes the route the retro-fill door for findings resolved before
 * the sibling route began recording beliefs itself.
 *
 * SAFE TO REPEAT rather than guarded against it. The belief is keyed on the FINDING, so a second
 * call re-asserts that same belief - replacing its text with whatever the finding now says - rather
 * than minting a duplicate. That is the correct reading of a replay: the finding row is the single
 * account of the decision, so memory should end up agreeing with it, including after an amended
 * note. Cheaper, too, than a guard that would have to decrypt the chain to find out. `{ recorded:
 * false }` with a reason is a normal answer here, not an error: lake memory may be off platform-wide
 * or for this lake.
 *
 * A SEPARATE DOOR from the sibling `POST /findings/:findingId`, which records the ruling and now
 * projects it here in the same call. Two routes because they answer different questions: that one
 * makes a decision, this one replays a decision already made, and folding the replay into the
 * decision route would mean a retro-fill had to pretend to re-resolve a finding that is already
 * terminal.
 *
 * MANAGE-gated via `assertLakeWriteAccess` (inside `loadFindingForLake`), matching the siblings.
 *
 * THROWS ARE DELIBERATELY UNCAUGHT here, unlike the resolve route. That route swallows because its
 * ruling is already committed and failing the request would report a durable write as not having
 * happened; this route commits nothing of its own, so a 500 loses exactly nothing and is honest
 * about a memory subsystem that is down - and a retro-fill is safe to retry, which is the whole
 * point of the door. Pinned by a test, so the asymmetry cannot be "tidied up" into a catch.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    // Before the first await: the crypto-shred fence refuses a write only when the purge lands at or
    // after this instant, so stamping it later would let a purge that landed mid-request lift its own
    // tombstone. See `recordFindingResolutionBelief`'s `startedAt`.
    const startedAt = new Date();
    const { id, findingId } = req.query as { id: string; findingId: string };

    const { lake, finding } = await loadFindingForLake(req, { lakeId: id, findingId });

    // An open finding has no ruling to record. 400 rather than a quiet `{ recorded: false }`: the
    // other non-recording outcomes are the system's state (memory is off), whereas this one is the
    // caller asking for something that does not exist yet, and answering both the same way would let
    // a UI show "nothing to record" for a finding that simply has not been triaged.
    if (finding.status === 'open') throw new BadRequestError('This finding has not been ruled on yet');

    const result = await recordFindingResolutionBelief(
      { lake, finding, status: finding.status, resolution: finding.resolution, startedAt },
      { logger: req.logger }
    );

    return res.json({ data: result });
  });

export const config = { api: { externalResolver: true } };

export default handler;
