import { Permission, getFileMembershipArm, type IFabFileDocument } from '@bike4mind/common';
import { dataLakeAccessGrantRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { getFabFileById } from '@server/managers/fabFileManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, parseOrBadRequest } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { sendToClient } from '@server/websocket/utils';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Request } from 'express';
import { Resource } from 'sst';
import { z } from 'zod';

const ReprocessInput = z.object({
  fabFileId: z.string().min(1),
  dataLakeId: z.string().min(1).optional(),
});
type ReprocessBody = z.infer<typeof ReprocessInput>;

/**
 * Resolve the file this caller may reprocess, or null if no grant applies.
 *
 * Two independent grants, in this order:
 *  - the caller's own CASL update right on the file (owner, user/group share, or global-write) -
 *    the historical rule, unchanged and still the fast path; and
 *  - manage rights on a data lake the file belongs to, when the caller NAMES that lake.
 *
 * The second exists because reprocess is lake maintenance rather than file authorship: it resets
 * derived state and re-derives chunks from bytes already stored, mutating no user content. The
 * whole-lake sibling (`POST /api/data-lakes/:id/rechunk`) has always authorized on exactly that
 * basis via `assertLakeRebuildAccess`, and `listDataLakes` computes the `canRebuild` flag the UI
 * lights this button with from the same predicate - so a lake manager who is not the uploader was
 * shown a capability this route then refused with a 404 (#3167).
 *
 * The lake must be NAMED rather than inferred from the file's tags: the caller states which lake's
 * authority they are acting under and membership is verified against it, so managing any lake never
 * becomes a licence to reprocess a file that lake does not hold. Inferring would also silently pick
 * a grant the caller never invoked, which is not something a refusal message could then explain.
 */
const resolveReprocessableFabFile = async (
  req: Request<unknown, unknown, ReprocessBody>,
  fabFileId: string,
  dataLakeId: string | undefined
): Promise<IFabFileDocument | null> => {
  const owned = await getFabFileById(fabFileId, req.ability!, Permission.update);
  if (owned) {
    if (!req.ability?.can?.(Permission.update, owned)) throw new BadRequestError('Unauthorized');
    return owned;
  }
  if (!dataLakeId) return null;

  // Scope-gated like the whole-lake sibling, which declares DATA_LAKE_READ_SCOPES and calls this on
  // its POST. Asserted HERE rather than on `baseApi` so the owner path keeps its existing scope
  // behaviour: this route is otherwise scope-less, and declaring a lake gate on the route would 403
  // every file-scoped key that reprocesses its own file. Without it, a key deliberately minted
  // without `datalake:write` could do through this door exactly what /api/data-lakes/:id/rechunk
  // refuses it. No-op for a browser caller - assertScope returns early when there is no apiKeyInfo.
  assertDataLakeWriteScope(req);

  // Throws (400) when the caller cannot rebuild the named lake. Not folded into the 404 below: the
  // caller named this lake, so its existence is not what is being protected, and the gate's own
  // wording is the only thing that distinguishes "you may not manage that lake" from "that file is
  // not in it" for someone debugging a refused repair.
  const ctx = await toAccessContext(req);
  const lake = await dataLakeService.assertLakeRebuildAccess(dataLakeId, ctx, {
    db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
  });

  const [file] = await fabFileRepository.findAllInIds([fabFileId]);
  // `findAllInIds` carries no soft-delete filter (unlike the whole-lake sibling's
  // `findChunkedFilesByScope`, which pins `deletedAt: null, archivedAt: null`), so a trashed or
  // archived member is excluded here rather than left reachable through the lake arm - it would
  // otherwise reset and re-chunk a file its owner removed, under the owner's own identity.
  if (!file || file.deletedAt || file.archivedAt) return null;
  // `resolveLakeMembershipScope`, not `lakeMembershipScope`: `assertLakeRebuildAccess` can hand back
  // a STATIC REGISTRY lake, whose synthetic document has no creator - an `owned` scope over it fails
  // closed to meta-tag-only and would drop the prefix arm most of a registry lake is made of.
  const scope = dataLakeService.resolveLakeMembershipScope(lake);
  // A non-member returns null and the caller gets the same 404 as a missing file. They hold no
  // rights over a file outside the lake they named, so a distinct refusal would confirm that a file
  // with that id exists to anyone who manages any lake at all.
  return getFileMembershipArm(file, scope) ? file : null;
};

/**
 * POST /api/files/reprocess  { fabFileId, dataLakeId? }
 *
 * Re-runs chunking + vectorization for an existing fabFile. Unlike /api/files/chunk
 * (which requires a chunkSize and doesn't reset state), this resets the processing
 * flags and clears the "no extractable text" note so re-extraction starts clean -
 * useful for files that landed with 0 chunks (failed/partial extraction).
 *
 * `dataLakeId` is optional and names the lake whose manage rights the caller is invoking, for a
 * member file they do not own - see `resolveReprocessableFabFile` for why it is required to be
 * explicit.
 */
const handler = baseApi().post(
  asyncHandler(async (req: Request<unknown, unknown, ReprocessBody>, res) => {
    // Zod, not a hand-written `!fabFileId` check, for the same reason the whole-lake sibling
    // parses with `RechunkInput`: `dataLakeId` now flows straight into `assertLakeRebuildAccess`'s
    // id-or-slug lookup, and an untyped JSON body is not what that gate's `string` contract expects.
    const { fabFileId, dataLakeId } = parseOrBadRequest(ReprocessInput, req.body);

    const fabFile = await resolveReprocessableFabFile(req, fabFileId, dataLakeId);
    if (!fabFile) throw new NotFoundError('FabFile not found');
    if (fabFile.isChunking) throw new BadRequestError('FabFile is currently being chunked');

    // Shared with the bulk "Rebuild passages" wave so the two reset paths cannot drift on which
    // fields they clear - notably `error`, which this route previously left set: a file that chunked
    // then failed vectorization stayed invisible to both the lake's under-chunked detection and the
    // rescue sweep after a reprocess.
    // The check above is a read; this is the write that actually decides. A worker can claim the
    // file in between, in which case the reset skips it and returns nothing - carry on and we would
    // report 'ongoing' and hand back a messageId for a delivery that loses the worker CAS and
    // re-chunks nothing, leaving the user with no signal at all.
    const [reset] = await fabFileRepository.resetChunkStateByIds([fabFileId]);
    if (!reset) throw new BadRequestError('FabFile is currently being chunked');

    // To the CALLER, who is the one watching this file's row - not necessarily its owner, now that a
    // lake manager can reach this route for someone else's file.
    await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
      action: 'update_file_chunk_vector_status',
      fabFileId,
      chunkStatus: 'ongoing',
    });

    const queueUrl = getSourceQueueUrl('fabFileChunkQueue');
    if (!queueUrl) throw new Error('Chunk queue URL not found');

    // `fabFile.userId`, deliberately not the caller: the re-chunk runs under the file OWNER's
    // identity so its chunk policy and spend attribution are unchanged by who asked for the repair.
    const messageId = await sendToQueue(queueUrl, { fabFileId: fabFile.id, userId: fabFile.userId });

    return res.json({ messageId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
