/**
 * SRE Tracking Detail API - Returns a single full tracking document by ID.
 */

import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { sreErrorTrackingRepository } from '@bike4mind/database';

const handler = adminApi({ adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler(async (req, res) => {
    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !isValidObjectId(id)) throw new NotFoundError('Invalid tracking ID');

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    res.status(200).json(doc);
  })
);

export default handler;
