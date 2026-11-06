import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { PROJECTS_WRITE_SCOPES } from '@server/projects/projectScopes';
import { setProjectSystemPrompt } from '@server/projects/projectSharingMutations';
import { respond } from '@server/utils/respond';
import { projectResponseSchema } from '@bike4mind/common';

const handler = baseApi({ requiredScopes: PROJECTS_WRITE_SCOPES }).post(
  asyncHandler<{ id: string }>(async (req, res) => {
    const { id } = req.query as { id: string };
    const { fileId } = req.body as { fileId: string };

    const project = await setProjectSystemPrompt(
      { user: req.user, ability: req.ability, logger: req.logger },
      id,
      fileId
    );

    return respond(res, projectResponseSchema, project);
  })
);

export default handler;
