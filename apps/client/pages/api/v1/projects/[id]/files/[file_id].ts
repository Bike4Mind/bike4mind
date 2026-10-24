/**
 * DELETE /api/v1/projects/{id}/files/{file_id} - the single-file twin of DELETE /api/projects/[id]/files.
 *
 * The file is named `[file_id]` so Next's dynamic segment matches the contract's path parameter.
 * removeFiles answers 400 for an id the caller cannot read; for a path-addressed resource that is a
 * 404, as is an id that cannot address a row at all.
 */
import { BadRequestError, NotFoundError, removeProjectFileContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { removeFilesFromProject } from '@server/projects/projectContentMutations';

const removeRoute = nextRouteForContract(removeProjectFileContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/projects/[id]/files/[file_id]'),
}).delete(async (req, res) => {
  const { id, file_id: fileId } = req.validatedParams;
  if (!isValidObjectId(fileId)) throw new NotFoundError('File not found');

  try {
    await removeFilesFromProject({ user: req.user, ability: req.ability, logger: req.logger }, id, [fileId]);
  } catch (error) {
    if (error instanceof BadRequestError) throw new NotFoundError('File not found');
    throw error;
  }

  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ DELETE: removeRoute });
