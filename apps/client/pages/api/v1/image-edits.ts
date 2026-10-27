/**
 * POST /api/v1/image-edits - queue an image edit; the caller polls the returned quest.
 * Also served at the legacy `/api/ai/edit-image` (pages/api/ai/edit-image.ts re-exports this).
 *
 * Auth mode, the `ai:generate` scope and body validation all come from `editImageContract`.
 */

import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getImageEdit } from '@server/imageGenerations/imageEdit';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { assertNoStrayBillingOrgKeys, resolveBillingOrgInput } from '@bike4mind/server-utils/utils/orgAccess';
import { editImageContract } from '@bike4mind/common';
import { armGenerationCallback, resolveGenerationCallback } from '@server/generationCallback/armGenerationCallback';
import { assertReferenceImagesSupported } from '@server/utils/assertReferenceImagesSupported';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';

const handler = nextRouteForContract(editImageContract).post(async (req, res) => {
  assertAiAccessAllowed(req.user);
  assertNoStrayBillingOrgKeys(req.body);
  // organization_id is the request alias; only the mapped value goes on to the queue.
  const requestedOrgId = resolveBillingOrgInput(req.validated);
  const { callbackUrl, organization_id: _orgAlias, ...body } = req.validated;
  assertReferenceImagesSupported(body.model, body.referenceImageFabFileIds);
  const callback = await resolveGenerationCallback(req, callbackUrl);

  // Reject a session the caller can't write to before the service appends a quest to it.
  await getOrCreateSession({
    sessionId: body.sessionId,
    user: req.user,
    ability: req.ability,
    logger: req.logger,
    origin: resolveSessionOrigin(req),
  });

  // An org-billed API key bills its org; otherwise null = personal, undefined = the caller's own org.
  const effectiveOrgId = await resolveMediaBillingOrgId(req, requestedOrgId);

  const quest = await getImageEdit().invoke({
    adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo),
    userId: req.user.id,
    body: {
      ...body,
      organizationId: effectiveOrgId,
    },
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
