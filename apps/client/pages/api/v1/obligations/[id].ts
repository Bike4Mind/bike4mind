/**
 * GET   /api/v1/obligations/{id} - read one obligation. Another user's is `404`, like a missing one.
 * PATCH /api/v1/obligations/{id} - correct the extracted fields and/or confirm or dismiss.
 *
 * Confirming files the scan into the destination lake through the same gated membership write as
 * POST /api/v1/data-lakes/{id}/files/{file_id}, and the obligation update commits in that transaction,
 * so a refused or failed filing leaves the obligation unconfirmed.
 */
import { ForbiddenError, getObligationContract, updateObligationContract } from '@bike4mind/common';
import { obligationDayToDate, obligationRepository, type ObligationUpdate } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { addFileToWritableLake, assertLakeMembershipWritable } from '@server/dataLakes/lakeMembershipWrite';
import { serializeObligation } from '@server/obligations/serializeObligation';
import { assertCanFileObligationIntoLakes, canReadObligationLakes } from '@server/obligations/obligationLakeScopes';

const dismissedConflict = () => new ConflictError('This obligation was dismissed and can no longer change');

const RATE_BUCKET = 'GET /api/v1/obligations/[id]';

const getRoute = nextRouteForContract(getObligationContract, {
  rateLimit: perUserRateLimit(RATE_BUCKET),
  exemptReadsFromDailyRateLimit: true,
  recordsActivity: false,
}).get(async (req, res) => {
  // An obligation reads the user's files, spends credits and files into lakes, none of which a connected app is granted.
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot use obligations');
  }
  const item = await obligationRepository.findByIdForUser(req.validatedParams.id, req.user.id);
  if (!item) throw new NotFoundError('Obligation not found');
  return res.json(serializeObligation(item, { showDestination: canReadObligationLakes(req.apiKeyInfo) }));
});

const updateRoute = nextRouteForContract(updateObligationContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/obligations/[id]'),
}).patch(async (req, res) => {
  // An obligation reads the user's files, spends credits and files into lakes, none of which a connected app is granted.
  if (req.apiKeyInfo?.oauthExchangeClientId) {
    throw new ForbiddenError('Keys minted for a connected app cannot use obligations');
  }
  const userId = req.user.id;
  const body = req.validated;
  if (!Object.values(body).some(value => value !== undefined)) {
    throw new UnprocessableEntityError('Send at least one field to change');
  }
  const current = await obligationRepository.findByIdForUser(req.validatedParams.id, userId);
  if (!current) throw new NotFoundError('Obligation not found');
  if (current.status === 'dismissed') throw dismissedConflict();
  const id = current._id.toString();

  const set: ObligationUpdate = {};
  if (body.amount !== undefined) {
    set.amountValue = body.amount?.value ?? null;
    set.currency = body.amount?.currency ?? null;
  }
  if (body.payee !== undefined) set.payee = body.payee;
  if (body.due_date !== undefined) set.dueDate = body.due_date === null ? null : obligationDayToDate(body.due_date);
  if (body.destination_lake_id === null) {
    set.destinationLakeId = null;
    set.destinationName = null;
  }
  if (body.status !== undefined) set.status = body.status;
  const confirming = body.status === 'confirmed' && current.status !== 'confirmed';
  if (confirming) set.confirmedAt = new Date();

  const requestedLake = body.destination_lake_id;
  const targetLake = requestedLake !== undefined ? requestedLake : current.destinationLakeId;
  const lakeChanged = typeof requestedLake === 'string' && requestedLake !== current.destinationLakeId;
  const finalStatus = body.status ?? current.status;
  // Filing only ever adds: a destination changed after confirm files into the new lake, never out of the old.
  const fileInto = finalStatus === 'confirmed' && targetLake && (confirming || lakeChanged) ? targetLake : null;

  if (typeof requestedLake === 'string' || fileInto) {
    assertCanFileObligationIntoLakes(req.apiKeyInfo);
    if (!(await isFeatureEnabled('EnableDataLakes'))) throw new NotFoundError('Data lake not found');
  }
  const ctx = typeof requestedLake === 'string' || fileInto ? await toMemberAccessContext(req) : null;

  let updated;
  if (fileInto && ctx) {
    const { extra } = await addFileToWritableLake({
      lakeIdOrSlug: fileInto,
      ctx,
      actor: { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo) },
      resolveFileId: () => current.fileId,
      logger: req.logger,
      // Throwing rolls the membership back when a concurrent dismiss won.
      alsoInTransaction: async lake => {
        const row = await obligationRepository.applyUpdate(id, userId, {
          ...set,
          destinationLakeId: lake.id,
          destinationName: lake.name,
        });
        if (!row) throw dismissedConflict();
        return row;
      },
    });
    updated = extra;
  } else {
    if (typeof requestedLake === 'string' && ctx) {
      const lake = await assertLakeMembershipWritable(requestedLake, ctx, req.logger);
      set.destinationLakeId = lake.id;
      set.destinationName = lake.name;
    }
    updated = await obligationRepository.applyUpdate(id, userId, set);
  }
  // applyUpdate skips a dismissed row, so a miss here is a dismiss that landed after the read above.
  if (!updated) throw dismissedConflict();
  return res.json(serializeObligation(updated, { showDestination: canReadObligationLakes(req.apiKeyInfo) }));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute });
