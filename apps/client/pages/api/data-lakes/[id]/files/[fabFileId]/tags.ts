import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { SetLakeFileTagsRequestInput } from '@bike4mind/common';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/**
 * PUT /api/data-lakes/:id/files/:fabFileId/tags
 *
 * Sets a file's content tags UNDER THIS LAKE'S PREFIX to exactly the body's `tags` array -
 * scoped-replace semantics (see `setDataLakeFileTags`). Closes #2255: the sibling DELETE lets a
 * lake MANAGER (curator grant, org admin, platform admin - not necessarily the file's owner) pull
 * every tag under the lake's prefix, but the only other tag-write door
 * (`POST /api/files/tags/toggle`) is gated by the file's owner/share ACL. This door sits behind
 * the LAKE's manage gate instead, mirroring the sibling `[fabFileId].ts` doors - and it does NOT
 * write a `LakeMembershipRemoval`: it can only ever leave the file a member of this lake (a write
 * that would end membership is refused, not performed), so there is nothing for #2248's restore
 * door to undo here.
 *
 * The admission contract (#1680) IS consulted on this path - not for the URL lake, whose own
 * membership cannot flip through this door, but for every OTHER lake a write newly satisfies by
 * prefix arm (a co-prefixed third lake). See `setDataLakeFileTags`'s step 11.
 *
 * Fallback (built-in registry) lakes are refused by `assertLakeWritable` inside the service, same
 * as both sibling doors; this route does not pre-check it. Concurrency is
 * last-writer-partially-wins: the writes are element-level, not a whole-array rewrite, so the
 * response's `tags.current` (from a post-write re-read) is the authoritative answer, never the
 * computed intent - and the push itself is a per-name ordered `bulkWrite`, so a mid-batch failure
 * can leave a partial push. There is no undo for a bad PUT: this door stores no prior state, so
 * reconstructing an earlier tag set means reading the service's own log line.
 *
 * `invalidateLakeFileMembershipQueries` (apps/client/app/hooks/data/dataLakes.ts) is the
 * client-side invalidation fan-out a future UI hook for this door must call - exported for that
 * reason, since a membership-affecting write here is invisible to the query cache otherwise.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    const { tags } = SetLakeFileTagsRequestInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    const result = await dataLakeService.setDataLakeFileTags(actor, lake.id, fabFileId, tags, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fabFiles: fabFileRepository,
        scopedSettings: scopedSettingsRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
