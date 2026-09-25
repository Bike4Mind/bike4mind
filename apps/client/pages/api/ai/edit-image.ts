import { baseApi } from '@server/middlewares/baseApi';
import { getImageEdit } from '@server/queueHandlers/imageEdit';
import { getOrCreateSession } from '@server/managers/sessionManager';
import { resolveBillingOrgId } from '@server/utils/orgAccess';
import { ApiKeyScope } from '@bike4mind/common';

// Gate API-key callers on `ai:generate` so this billable action is auditable, mirroring
// generate-image.ts. Scope checks apply only to API-key requests; browser/JWT sessions fall
// through untouched (see apiKeyAuth).
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post(async (req, res) => {
  // Reject a session the caller can't write to before the service appends a quest to it. Skipped
  // when absent so the service's schema still 400s rather than a new session being created.
  if (req.body.sessionId) {
    await getOrCreateSession({
      sessionId: req.body.sessionId,
      user: req.user,
      ability: req.ability,
      logger: req.logger,
    });
  }

  // null = personal account, undefined = the caller's own org; any org the caller isn't a member of is rejected.
  const effectiveOrgId = await resolveBillingOrgId(req, req.body.organizationId);

  const quest = await getImageEdit().invoke({
    userId: req.user.id,
    body: {
      ...req.body,
      organizationId: effectiveOrgId,
    },
  });

  return res.json(quest);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
