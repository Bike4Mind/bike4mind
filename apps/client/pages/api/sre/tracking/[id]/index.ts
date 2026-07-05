/**
 * SRE Tracking Detail API - Returns a single full tracking document by ID.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { sreErrorTrackingRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) throw new NotFoundError('Invalid tracking ID');

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    res.status(200).json(doc);
  })
);

export default handler;
