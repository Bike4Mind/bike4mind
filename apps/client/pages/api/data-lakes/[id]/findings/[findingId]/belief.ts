import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeFindingRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
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
 * SAFE TO REPEAT rather than guarded against it. The ledger folds by subject, so a second call
 * AFFIRMS the existing belief instead of minting a duplicate - which is the correct reading of a
 * curator standing by their ruling, and cheaper than a guard that would have to decrypt the chain to
 * find out. `{ recorded: false }` with a reason is a normal answer here, not an error: lake memory
 * may be off platform-wide or for this lake.
 *
 * A SEPARATE DOOR from the sibling `POST /findings/:findingId`, which records the ruling and now
 * projects it here in the same call. Two routes because they answer different questions: that one
 * makes a decision, this one replays a decision already made, and folding the replay into the
 * decision route would mean a retro-fill had to pretend to re-resolve a finding that is already
 * terminal.
 *
 * MANAGE-gated via `assertLakeWriteAccess`, matching the sibling findings routes.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id, findingId } = req.query as { id: string; findingId: string };
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    // Belongs-to-lake, for the same reason the sibling route checks it: the gate above authorized a
    // LAKE, so without this a caller who manages one lake could project any finding in the database
    // into their own lake's memory by quoting their lake in the URL. Not-found rather than forbidden,
    // so the refusal leaks nothing about findings in lakes the caller cannot see.
    const finding = await dataLakeFindingRepository.findById(findingId);
    if (!finding || finding.lakeId !== lake.id) throw new NotFoundError('Finding not found');

    // An open finding has no ruling to record. 400 rather than a quiet `{ recorded: false }`: the
    // other non-recording outcomes are the system's state (memory is off), whereas this one is the
    // caller asking for something that does not exist yet, and answering both the same way would let
    // a UI show "nothing to record" for a finding that simply has not been triaged.
    if (finding.status === 'open') throw new BadRequestError('This finding has not been ruled on yet');

    const result = await recordFindingResolutionBelief(
      { lake, finding, status: finding.status, resolution: finding.resolution },
      { logger: req.logger }
    );

    return res.json({ data: result });
  });

export const config = { api: { externalResolver: true } };

export default handler;
