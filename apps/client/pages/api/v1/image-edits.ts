/**
 * POST /api/v1/image-edits - queue an image edit; the caller polls the returned quest.
 * Also served at the legacy `/api/ai/edit-image` (pages/api/ai/edit-image.ts re-exports this).
 *
 * Auth mode, the `ai:generate` scope and body validation all come from `editImageContract`.
 */

import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getImageEdit } from '@bike4mind/server-utils/imageGenerations/imageEdit';
import { getOrCreateSession } from '@bike4mind/server-utils/managers/sessionManager';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { assertNoStrayBillingOrgKeys, resolveBillingOrgInput } from '@bike4mind/server-utils/utils/orgAccess';
import { editImageContract, validateBflEditRegions, isFlux3ImageModel } from '@bike4mind/common';
import { armGenerationCallback, resolveGenerationCallback } from '@server/generationCallback/armGenerationCallback';
import { assertReferenceImagesSupported } from '@server/utils/assertReferenceImagesSupported';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { assertRunBudgetHeadroom } from '@bike4mind/server-utils/billing/runBudgetClaim';
import type { ImageGenerationRun } from '@bike4mind/services/llm/ImageGeneration';
import { resolvePaidCallRun } from '@server/completionRuns/paidCallRun';

const handler = nextRouteForContract(editImageContract).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  assertNoStrayBillingOrgKeys(req.body);
  // organization_id is the request alias; only the mapped value goes on to the queue.
  const requestedOrgId = resolveBillingOrgInput(req.validated);
  const { callbackUrl, organization_id: _orgAlias, run: requestedRun, ...body } = req.validated;
  assertReferenceImagesSupported(body.model, body.referenceImageFabFileIds);

  if (isFlux3ImageModel(body.model) && body.fabFileIds.length)
    return res.status(400).json({ error: 'FLUX 3 edits take no mask; omit fabFileIds' });

  if (body.edit_regions?.length) {
    if (!isFlux3ImageModel(body.model)) {
      return res.status(400).json({ error: 'edit_regions are only supported on FLUX 3 models' });
    }
    const regionIssues = validateBflEditRegions(body.edit_regions);
    if (regionIssues.length) {
      return res.status(422).json({ error: regionIssues.join('; ') });
    }
  }
  const callback = await resolveGenerationCallback(req, callbackUrl);

  // Before getOrCreateSession, as in image-generations: a refused payer or someone else's run touches nothing.
  // A run bills the account it is bound to, so the charge lands where the run's usage read looks for it.
  const paidRun = await resolvePaidCallRun(
    { user: req.user, apiKeyInfo: req.apiKeyInfo },
    requestedRun,
    requestedOrgId
  );
  // The worker's credit hold claims the run budget; this only refuses up front what cannot fit.
  const run: ImageGenerationRun | undefined = paidRun && {
    attribution: paidRun.attribution,
    assertHeadroom: credits => assertRunBudgetHeadroom(paidRun.attribution.runId, credits),
  };

  // Reject a session the caller can't write to before the service appends a quest to it.
  await getOrCreateSession({
    sessionId: body.sessionId,
    user: req.user,
    ability: req.ability,
    logger: req.logger,
    origin: resolveSessionOrigin(req),
  });

  // Otherwise an org-billed API key bills its org; null = personal, undefined = the caller's own org.
  const effectiveOrgId = paidRun ? paidRun.billingOrganizationId : await resolveMediaBillingOrgId(req, requestedOrgId);

  const quest = await getImageEdit().invoke({
    adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo),
    apiKeyId: req.apiKeyInfo?.keyId,
    apiKeyBillingOwnerType: req.apiKeyInfo?.billingOwnerType,
    userId: req.user.id,
    body: {
      ...body,
      organizationId: effectiveOrgId,
    },
    run,
  });

  await armGenerationCallback(quest.id, callback, req.logger);

  return res.json(quest);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
