/**
 * GET    /api/v1/files/{id} - read one file back, with a signed download URL once it is
 *                             downloadable. Doubles as the upload poll for POST /api/v1/files.
 * PATCH  /api/v1/files/{id} - rename a file or change its notes; the public twin of PUT /api/files/[id].
 * DELETE /api/v1/files/{id} - the public twin of DELETE /api/files/[id].
 *
 * Loading, updating and deleting are shared with the SPA-internal /api/files/[id] route
 * (`loadAccessibleFabFile`, `updateFileForUser`, `deleteFileForUser`), so the doors
 * cannot authorize differently; these handlers only map the published snake_case shape.
 */

import { deleteFileContract, getFileContract, updateFileContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { deleteFileForUser } from '@server/files/deleteFileForUser';
import { updateFileForUser } from '@server/files/updateFileForUser';
import { toPublicFile, type PublicFileSource } from '@server/files/toPublicFile';
import { isValidObjectId } from '@server/utils/objectId';
import { NotFoundError } from '@server/utils/errors';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
function assertValidFileId(id: string) {
  if (!isValidObjectId(id)) throw new NotFoundError('File not found');
}

const getRoute = nextRouteForContract(getFileContract, {
  // Polling an upload should cost one daily slot, not one per poll. Only safe methods are
  // exempted, and the per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  assertValidFileId(id);

  const fabFile = await loadAccessibleFabFile(req, id);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicFile(fabFile));
});

const updateRoute = nextRouteForContract(updateFileContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/files/[id]'),
}).patch(async (req, res) => {
  const { id } = req.validatedParams;
  assertValidFileId(id);
  const { file_name, notes } = req.validated;

  // updateFabFile only reaches the lake gates when `tags` is passed, which this body cannot carry;
  // they are wired exactly as PUT /api/files/[id] wires them so that stays true by construction
  // rather than by stub. Its update-access lookup answers a denial with NotFoundError.
  const ctx = await toAccessContext(req);
  const updated = await updateFileForUser(req, ctx.administeredOrgIds, {
    id,
    // Spread so an omitted field stays absent instead of being set undefined.
    ...(file_name !== undefined && { fileName: file_name }),
    ...(notes !== undefined && { notes }),
  });

  res.setHeader('Cache-Control', 'private, no-store');
  try {
    // Re-read rather than project `updated`: the read path signs a fresh download URL.
    return res.json(toPublicFile(await loadAccessibleFabFile(req, id)));
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // Update access is not a subset of read access, and the write has already committed, so answer
    // with the updated file minus its stored (possibly stale) URL rather than a 404. The cast is safe:
    // updateFabFile returns the whole loaded document with the changes spread over it.
    return res.json(toPublicFile({ ...(updated as PublicFileSource), fileUrl: undefined }));
  }
});

const deleteRoute = nextRouteForContract(deleteFileContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/files/[id]'),
}).delete(async (req, res) => {
  const { id } = req.validatedParams;
  assertValidFileId(id);

  // 'unshared' is a success too: a sharee's delete removes their own access (see the contract).
  const action = await deleteFileForUser(req, id);
  if (action === 'not_found' || action === 'denied') throw new NotFoundError('File not found');

  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute, DELETE: deleteRoute });
