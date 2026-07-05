import { baseApi } from '@server/middlewares/baseApi';
import { getImageEdit } from '@server/queueHandlers/imageEdit';

const handler = baseApi().post(async (req, res) => {
  // Include organizationId from request body or fall back to user's organization
  const effectiveOrgId =
    req.body.organizationId !== undefined ? req.body.organizationId : (req.user.organizationId?.toString() ?? null);

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
