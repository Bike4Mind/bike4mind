import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_OR_SHARE_SCOPES, assertDataLakeShareScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  withTransaction,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { lakeOwnershipOfferDb } from '@server/dataLakes/lakeOwnershipOfferDb';
import { sendLakeOwnershipOfferEmail } from '@server/utils/dataLakeOwnershipOfferNotifier';

const TransferOwnershipInput = z.object({
  newOwnerUserId: z.string().min(1),
});

/**
 * GET    /api/data-lakes/:id/transfer-ownership -> { data: LakeOwnershipCandidateList, pendingOffer }
 * POST   /api/data-lakes/:id/transfer-ownership  { newOwnerUserId } -> { offer }
 * DELETE /api/data-lakes/:id/transfer-ownership  -> { offer }
 *
 * BREAKING: POST no longer transfers ownership. It opens a PENDING OFFER that the recipient must
 * accept; ownership is unchanged until then. An owner grant carries the lake's `systemPrompt` into
 * the holder's turns (#2495), so pushing one onto an unwitting member was an injection channel, not
 * just a surprising role change - the offer is what makes the recipient a party to it. The old
 * synchronous behaviour is gone, not deprecated.
 *
 * The GET is the option set behind the transfer picker plus (when one is open) the pending offer, so
 * the dialog can show "waiting on X" with a cancel. It returns an EMPTY list rather than a 403 when
 * the caller may read but not transfer, so the modal simply shows no control.
 *
 * Access-gated first (not-found-style denial), then the service enforces the narrower transfer
 * authorization (platform admin, current effective owner, or an admin of the lake's org).
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_OR_SHARE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const ctx = await toAccessContext(req);

    // Same not-found-style read gate as the writes: a lake the caller cannot see is not disclosed.
    // The grants come back with it so the pending-offer disclosure below costs no extra read.
    const { lake, grants } = await dataLakeService.assertLakeAccessWithGrants(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const data = await dataLakeService.listLakeOwnershipCandidates(lake, ctx, {
      db: {
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        users: userRepository,
        organizations: organizationRepository,
      },
    });
    const offer = await dataLakeService.findPendingLakeOwnershipOffer(lake.id, { db: lakeOwnershipOfferDb });
    // Disclose the live offer only to someone who could have made it, or to its offerer. The row names
    // who is about to become owner, which a mere reader of the lake (a reader grantee, an org member on
    // an org-visible lake, a `datalake:read` key) has no business learning - the member roster this
    // dialog lists is manager-only for the same reason.
    const pendingOffer =
      offer &&
      (dataLakeService.resolveLakeTransferAuthority(lake, ctx, grants).allowed ||
        offer.recipientUserId === ctx.userId ||
        offer.offeredByUserId === ctx.userId)
        ? offer
        : null;

    return res.json({ data, pendingOffer });
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    assertDataLakeShareScope(req);
    const { id } = req.query;
    const { newOwnerUserId } = TransferOwnershipInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    // The gate has to be INSIDE the callback: the offer's authorization is decided from the lake and
    // the grants, and a transaction retry must re-read rather than reuse a snapshot that another
    // transfer (or a departure) has already superseded. The service then records the offer and stops
    // - no grant is touched here.
    const offer = await withTransaction(async () => {
      const { lake, grants } = await dataLakeService.assertLakeAccessWithGrants(id, ctx, {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });

      return dataLakeService.offerLakeOwnership(actor, lake, grants, newOwnerUserId, {
        db: lakeOwnershipOfferDb,
      });
    });

    // AFTER commit, never inside it: a slow or failing SMTP call must not hold the transaction open,
    // and the notifier swallows its own failures so a mail problem cannot fail the offer.
    await sendLakeOwnershipOfferEmail(
      {
        kind: 'offered',
        toUserId: offer.recipientUserId,
        dataLakeId: offer.dataLakeId,
        ...(req.user?.name || req.user?.username ? { counterpartName: req.user.name || req.user.username } : {}),
        expiresAt: offer.expiresAt,
      },
      { logger: req.logger }
    );

    return res.json({ offer });
  })
  .delete(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    assertDataLakeShareScope(req);
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    // Gated like the GET: cancelling is open to the offerer and to anyone who currently holds
    // transfer authority, which is a fact about this lake and its grants.
    const offer = await withTransaction(async () => {
      const { lake, grants } = await dataLakeService.assertLakeAccessWithGrants(id, ctx, {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });

      return dataLakeService.cancelLakeOwnershipOffer(actor, lake, grants, { db: lakeOwnershipOfferDb });
    });

    return res.json({ offer });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
