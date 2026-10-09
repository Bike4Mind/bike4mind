import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { DATALAKE_TAG_PREFIX, SetLakeFileTagsRequestInput, prefixArmTagNames } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import {
  withTransaction,
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
 *
 * GET /api/data-lakes/:id/files/:fabFileId/tags
 *
 * The current name of every tag this file carries UNDER THIS LAKE'S PREFIX, plus that prefix -
 * what the retag UI needs to seed an editable set, because `setDataLakeFileTags` is replace
 * semantics (an omitted name is a removed name, see that door). Read-SCOPED while the PUT above is
 * write-scoped, the mixed-method split `inconsistencies.ts` documents: a browser caller is gated by
 * the route's scope list but the PUT still asserts `datalake:write` in-handler. MANAGE-gated like
 * the PUT and for the same reason: it returns a member file's own categorization, and it exists
 * only to seed a write - offering it to a reader would promise a control they cannot use.
 *
 * The prefix comes from the SAME `decideStampPrefix` gate the write door runs (including its
 * fail-closed overlap check), so the names returned are exactly the names a retag may submit; a
 * prefix this lake cannot stamp under refuses here rather than seeding a set the PUT would reject.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    assertDataLakeWriteScope(req);
    const { id, fabFileId } = req.query;
    const { tags } = SetLakeFileTagsRequestInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    // The gate runs inside the transaction so a grant revoke committing mid-request collides on the
    // lake doc and the retry re-reads live grants.
    const result = await withTransaction(async () => {
      const lake = await dataLakeService.assertLakeAccessById(id, ctx, {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });
      dataLakeService.assertLakeWritable(lake);

      const retagged = await dataLakeService.setDataLakeFileTags(actor, lake.id, fabFileId, tags, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          fabFiles: fabFileRepository,
          scopedSettings: scopedSettingsRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      });
      // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
      await dataLakeRepository.touchIfStable(lake.id);
      return retagged;
    });

    return res.json(result);
  })
  .get(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    // The manage gate explicitly: unlike the PUT above, this read does not pass through a service
    // door that would apply `canManageLake` for it. Same gate and same message as the write door,
    // so the retag UI is offered only where the write it seeds would land.
    const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canManage) {
      throw new BadRequestError("You do not have permission to change this data lake's files");
    }

    // The same prefix gate the write door runs, including its fail-closed overlap check.
    const decision = await dataLakeService.decideStampPrefix(lake, { dataLakes: dataLakeRepository });
    if (!decision.stamp) throw new BadRequestError(dataLakeService.stampRefusalMessage(decision));
    if (decision.overlapCheckFailed) {
      throw new BadRequestError(dataLakeService.UNVERIFIED_PREFIX_OVERLAP_REFUSAL);
    }

    // Membership, not bare existence: a retag seeds from a file in THIS lake, and the write door
    // refuses a non-member at the same point (and with the same message).
    const file = await fabFileRepository.findById(fabFileId);
    if (!file || file.deletedAt || !dataLakeService.lakeMembershipSignals(lake, file).inLake) {
      throw new NotFoundError('File not found in this data lake');
    }

    const names = (file.tags ?? []).map(tag => tag?.name).filter((name): name is string => typeof name === 'string');
    // Mirrors `setDataLakeFileTags` step 18: under the prefix, reserved-namespace names excluded.
    const current = prefixArmTagNames(names, decision.prefix).filter(name => !name.startsWith(DATALAKE_TAG_PREFIX));

    return res.json({ prefix: decision.prefix, current });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
