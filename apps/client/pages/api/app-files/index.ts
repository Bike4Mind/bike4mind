import { IAppFileGetAllApiResponse } from '@bike4mind/common';
import { AppFile } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import qs from 'qs';
import { z } from 'zod';

const AppFileGetAllRequestInput = z.object({
  tags: z.array(z.string()).optional(),
});

const handler = baseApi().get(
  asyncHandler<unknown, IAppFileGetAllApiResponse, {}, Record<string, string>>(async (req, res) => {
    // This is a cross-user file inventory with owner PII (populated name/email) and
    // no per-user scoping; its only consumer is the admin Files tab, so gate to admins.
    ensureAdmin(req.user?.isAdmin);

    const data = AppFileGetAllRequestInput.parse(qs.parse(req.query));

    const files = await AppFile.find({
      // $all: file must contain every queried tag
      ...(data.tags && { tags: { $all: data.tags } }),
    })
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .exec();

    return res.json(files as unknown as IAppFileGetAllApiResponse);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
