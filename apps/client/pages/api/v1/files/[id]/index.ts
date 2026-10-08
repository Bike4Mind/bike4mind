/**
 * GET    /api/v1/files/{id} - read one file back, with a signed download URL once it is
 *                             downloadable. Doubles as the upload poll for POST /api/v1/files.
 * PATCH  /api/v1/files/{id} - rename a file or change its notes; the public twin of PUT /api/files/[id].
 * DELETE /api/v1/files/{id} - the public twin of DELETE /api/files/[id].
 *
 * Loading, updating and deleting are shared with the SPA-internal /api/files/[id] route
 * (`loadAccessibleFabFile`, `fabFilesService.updateFabFile`, `deleteFileForUser`), so the doors
 * cannot authorize differently; these handlers only map the published snake_case shape.
 */

import { deleteFileContract, FileEvents, getFileContract, updateFileContract } from '@bike4mind/common';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  scopedSettingsRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { deleteFileForUser } from '@server/files/deleteFileForUser';
import { toPublicFile } from '@server/files/toPublicFile';
import { logEvent } from '@server/utils/analyticsLog';
import { getFilesStorage } from '@server/utils/storage';
import { isValidObjectId } from '@server/utils/objectId';
import { NotFoundError } from '@server/utils/errors';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// Named so every file id shares one bucket per method instead of one per pathname.
const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });

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

  // updateFabFile only reaches the lake adapters when `tags` is passed, which this body cannot
  // carry; they are wired exactly as PUT /api/files/[id] wires them so that stays true by
  // construction rather than by stub. Its update-access lookup answers a denial with NotFoundError.
  const ctx = await toAccessContext(req);
  const updated = await withTransaction(() =>
    fabFilesService.updateFabFile(
      req.user,
      {
        id,
        // Spread so an omitted field stays absent instead of being set undefined.
        ...(file_name !== undefined && { fileName: file_name }),
        ...(notes !== undefined && { notes }),
      },
      {
        db: {
          fabFiles: fabFileRepository,
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
          ...lakeMembershipAuditDb,
          scopedSettings: scopedSettingsRepository,
        },
        administeredOrgIds: ctx.administeredOrgIds,
        auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        assertWriteScope: () => assertDataLakeWriteScope(req),
        logger: req.logger,
        storage: {
          upload: (filepath, content, option) => getFilesStorage().upload(content, filepath, option),
          generateSignedUrl: (path: string, expireInSeconds: number) =>
            getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
        },
      }
    )
  );

  // Same analytics event PUT /api/files/[id] emits.
  await logEvent(
    {
      userId: req.user.id,
      type: FileEvents.UPDATE_FILE,
      metadata: { fileId: id, fileContent: updated.filePath ?? '' },
    },
    { ability: req.ability }
  );

  // Re-read rather than project `updated`: the read path signs a fresh download URL.
  const fabFile = await loadAccessibleFabFile(req, id);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicFile(fabFile));
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
