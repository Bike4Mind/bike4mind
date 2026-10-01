/**
 * POST /api/v1/image-edits - queue an image edit; the caller polls the returned quest.
 * Also served at the legacy `/api/ai/edit-image` (pages/api/ai/edit-image.ts re-exports this).
 *
 * Auth mode, the `ai:generate` scope and body validation all come from `editImageContract`.
 */

import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getImageEdit } from '@server/queueHandlers/imageEdit';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { editImageContract } from '@bike4mind/common';
import { armGenerationCallback, resolveGenerationCallback } from '@server/generationCallback/armGenerationCallback';

const handler = nextRouteForContract(editImageContract).post(async (req, res) => {
  const { callbackUrl, ...body } = req.validated;
  const callback = await resolveGenerationCallback(req, callbackUrl);

  // Reject a session the caller can't write to before the service appends a quest to it.
  await getOrCreateSession({
    sessionId: body.sessionId,
    user: req.user,
    ability: req.ability,
    logger: req.logger,
  });

  // null = personal account, undefined = the caller's own org; any org the caller isn't a member of is rejected.
  const effectiveOrgId = await resolveBillingOrgId(req, body.organizationId);

  const quest = await getImageEdit().invoke({
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
