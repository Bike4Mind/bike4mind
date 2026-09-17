import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  dataLakeProposalRepository,
  organizationRepository,
  userRepository,
  adminSettingsRepository,
  fallbackLakeSettingsRepository,
} from '@bike4mind/database';
import { CreateDataLakeRequestInput, BadRequestError, ForbiddenError } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { isValidObjectId } from '@server/utils/objectId';
import { resolveActiveOrg } from '@server/utils/resolveActiveOrg';

const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes - list accessible data lakes
  .get(async (req: Request, res) => {
    const ctx = await toAccessContext(req);
    // The `users` adapter labels lakes the caller does not own with the creator's name: the
    // manager list is "lakes I can reach", not "lakes I own" (org lakes, others' public lakes,
    // and - for an admin - every tenant's lakes surface here), so a not-own lake is marked to
    // prevent an admin from managing someone else's by mistake.
    const db = {
      dataLakes: dataLakeRepository,
      users: userRepository,
      // Grant repo: makes isOwn/canManage labels grant-aware and surfaces a transferred/granted lake.
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
      // Settings repo: read-time grant cutover flag (#1673). Keeps the list in lockstep with the
      // single gate - reader-granted lakes list only once EnforceLakeReadGrants is on (report-only off).
      settings: adminSettingsRepository,
      // Static (registry) lakes' admin-settable session-default overlay (groundingMode,
      // preferredSystemPromptId, systemPrompt). Only ever consulted on the admin
      // (listAllDataLakes) branch below.
      fallbackLakeSettings: fallbackLakeSettingsRepository,
      // Proposal repo: puts a pending-review count on each lake the caller can manage (#1671). This is
      // the queue's only discovery surface - without it a reviewer has to open a lake's settings to
      // learn whether anything is waiting, which nobody does unprompted.
      dataLakeProposals: dataLakeProposalRepository,
      // Org repo: resolves the org-admin rung of `canPreauthorize` for an admin caller, whose
      // ctx.administeredOrgIds is deliberately zeroed. Without it that rung goes dark on this list.
      organizations: organizationRepository,
    };
    // `?preauthorizableFor=<userId>` labels `canPreauthorize` for that user instead of the caller,
    // so the admin key-mint picker can offer exactly the lakes the mint route will accept (#2945).
    // The row set is unchanged either way - only the admission label moves.
    // Every PRESENT value is screened, and anything but one well-formed id is refused rather than
    // dropped: a silently ignored param answers with the CALLER's admission labels, which is the
    // exact mislabeling this parameter exists to remove, and the caller only learns of it as a 400
    // from the mint route much later. So `!== undefined` rather than truthiness (a bare
    // `?preauthorizableFor=` is a present, empty string) and a typeof test that rejects the
    // array express hands back for a repeated `?a=1&a=2`, instead of letting it fall through.
    const rawPreauthorizableFor = req.query.preauthorizableFor;
    let preauthorizeForUserId: string | undefined;
    if (rawPreauthorizableFor !== undefined) {
      if (!ctx.isAdmin) {
        throw new ForbiddenError('preauthorizableFor is admin-only');
      }
      // Unchecked, a malformed id reaches the org-admin lookup as a CastError and surfaces as a 500.
      if (typeof rawPreauthorizableFor !== 'string' || !isValidObjectId(rawPreauthorizableFor)) {
        throw new BadRequestError('preauthorizableFor must be a single user id');
      }
      preauthorizeForUserId = rawPreauthorizableFor;
    }

    // Admins see all data lakes; non-admins see only those they can access (owner/org/tag).
    const dataLakes = ctx.isAdmin
      ? await dataLakeService.listAllDataLakes(ctx, { db, logger: req.logger, preauthorizeForUserId })
      : await dataLakeService.listDataLakes(ctx, { db });

    return res.json({ data: dataLakes });
  })
  // POST /api/data-lakes - create a new data lake
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const userId = req.user.id;
    const params = CreateDataLakeRequestInput.parse(req.body);

    // Scope to the caller's active account-switcher org (sent in the body), authorization-
    // validated against their memberships first - never trusted as-is. Undefined -> personal.
    const organizationId = await resolveActiveOrg(req, params.organizationId);

    const dataLake = await dataLakeService.createDataLake(
      userId,
      params,
      {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
        logger: req.logger,
      },
      organizationId
    );

    return res.status(201).json(dataLake);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
