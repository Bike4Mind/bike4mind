import { baseApi } from '@server/middlewares/baseApi';
import { PROJECTS_WRITE_SCOPES } from '@server/projects/projectScopes';
import { removeProjectMember } from '@server/projects/projectSharingMutations';
import { respond } from '@server/utils/respond';
import { projectResponseSchema } from '@bike4mind/common';

const handler = baseApi({ requiredScopes: PROJECTS_WRITE_SCOPES }).delete(async (req, res) => {
  const { userId: memberIdToRemove } = req.body;
  const result = await removeProjectMember(
    { user: req.user, ability: req.ability, logger: req.logger },
    req.query.id as string,
    memberIdToRemove || undefined
  );
  return respond(res, projectResponseSchema, result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
