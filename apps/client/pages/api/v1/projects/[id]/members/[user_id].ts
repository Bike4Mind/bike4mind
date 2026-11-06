/**
 * DELETE /api/v1/projects/{id}/members/{user_id} - the public twin of DELETE /api/projects/[id]/members.
 *
 * One path for both cases the SPA route splits on the body: naming yourself leaves the project,
 * naming someone else removes them as the owner. The file is named `[user_id]` so Next's dynamic
 * segment matches the contract's path parameter.
 */
import { ForbiddenError, NotFoundError, UnauthorizedError, removeProjectMemberContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { removeProjectMember } from '@server/projects/projectSharingMutations';

const removeRoute = nextRouteForContract(removeProjectMemberContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/projects/[id]/members/[user_id]'),
}).delete(async (req, res) => {
  const { id, user_id: userId } = req.validatedParams;
  if (!isValidObjectId(id)) throw new NotFoundError('Project not found');

  const isSelf = userId === req.user.id;
  try {
    await removeProjectMember(
      { user: req.user, ability: req.ability, logger: req.logger },
      id,
      isSelf ? undefined : userId
    );
  } catch (error) {
    // The service's refusals (not the owner; the owner leaving) are 401s on the SPA route, but the
    // caller is authenticated here, so the contract answers them as 403.
    if (error instanceof UnauthorizedError) throw new ForbiddenError(error.message);
    throw error;
  }

  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ DELETE: removeRoute });
