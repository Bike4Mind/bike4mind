import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  lakeMembershipDecisionRepository,
  lakeMembershipRemovalRepository,
} from '@bike4mind/database';
import { REPAIR_DECISIONS } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/**
 * POST /api/data-lakes/:id/membership-decisions
 *
 * Record the owner's answer to "this lake already holds this document" and carry it out (#2238).
 * The question is raised by the same-identity check at the post-chunk admission checkpoint
 * (`detectAdmissionDuplicates`); this is where the answer lands.
 *
 * `keep-newest` and `keep-specific` REMOVE the copies the ruling does not keep, through the ordinary
 * lake-scoped removal door - so a replacement leaves the file in its owner's Files list and in every
 * other lake it belongs to, and mints the same short-TTL restore record, which is what gives a
 * replacement an Undo. `keep-both` writes the tombstone and removes nothing, so a repair run does not
 * re-ask about a pair the owner deliberately created. There is no third outcome to send: cancelling
 * is not answering, so the client simply does not call this.
 *
 * The vocabulary is `REPAIR_DECISIONS`, shared verbatim with the repair plan (#2245) rather than
 * restated here. One vocabulary and one collection: a ruling made at this door and one made from a
 * repair plan differ only in the `source` stamped on the row.
 *
 * MANAGE-gated, not write-gated: this removes lake membership, so it is the same rung
 * `addFileToDataLake` and the removal door apply, resolved through `resolveCanManageLake` so a
 * curator / transferred owner / org grant is honored. Not-found-style denial on read, so a caller
 * cannot probe a lake's existence.
 */

const decisionBodySchema = z
  .object({
    fileName: z.string().min(1),
    decision: z.enum(REPAIR_DECISIONS),
    keptFabFileId: z.string().min(1).nullish(),
  })
  // The pairing is enforced here as well as in the service and on the schema, because this is the
  // layer that turns an arbitrary body into the discriminated input the service is typed against -
  // and it is the only one of the three that can answer 400 with the field name in it.
  .refine(body => (body.decision === 'keep-specific') === !!body.keptFabFileId, {
    message: 'keptFabFileId is required for keep-specific and meaningless for any other decision',
    path: ['keptFabFileId'],
  });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const parsed = decisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid membership decision');
    }

    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canManage) {
      throw new BadRequestError('You do not have permission to resolve duplicates in this data lake');
    }

    // The removal inside recomputes stats, which can flip a draft lake active and emit a
    // config-change row; `auditPrincipal` is what keeps a key-driven call from being recorded as
    // the human.
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    const { group, removedFabFileIds } = await dataLakeService.applyAdmissionDecision(
      actor,
      lake,
      parsed.data.decision === 'keep-specific'
        ? { fileName: parsed.data.fileName, decision: 'keep-specific', keptFabFileId: parsed.data.keptFabFileId! }
        : { fileName: parsed.data.fileName, decision: parsed.data.decision, keptFabFileId: null },
      {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          fabFiles: fabFileRepository,
          lakeMembershipDecisions: lakeMembershipDecisionRepository,
          // The removal door's restore record - required, not optional: without it "Undo" on a
          // replacement silently does nothing.
          lakeMembershipRemovals: lakeMembershipRemovalRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      }
    );

    return res.json({
      success: true,
      fileName: group.fileName,
      decision: parsed.data.decision,
      tier: group.tier,
      bucket: group.bucket,
      removedFabFileIds,
    });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
