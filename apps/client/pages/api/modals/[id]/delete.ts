import { ModalModel } from '@bike4mind/database/social';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { modalAuditTitle } from '@client/server/tools/modalOperations';
import { recordModalChanges } from '@client/server/tools/recordModalChanges';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id: string | string[] }>(async (req, res) => {
    const rawId = req.query.id;
    // Handle array case (Next.js dynamic routes can return arrays)
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) throw new BadRequestError('Invalid ID');

    if (!req.ability) throw new ForbiddenError('Ability not found');
    if (!req.ability.can('delete', ModalModel)) throw new ForbiddenError('Permission denied');

    // Guard the cast: an invalid ObjectId would otherwise surface as a 500, not a 404.
    if (!isValidObjectId(id)) throw new NotFoundError('Modal not found');

    const deletedModal = await ModalModel.findOneAndDelete({ _id: id });
    if (!deletedModal) throw new NotFoundError('Modal not found');
    await recordModalChanges(
      req,
      [
        {
          kind: 'deleted',
          id: String(deletedModal._id),
          title: modalAuditTitle(deletedModal),
        },
      ],
      'admin-modals'
    );

    return res.status(200).json(deletedModal);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
