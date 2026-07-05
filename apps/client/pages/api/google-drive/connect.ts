import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { getAuthUrl } from '@server/integrations/google/drive/common';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const authUrl = getAuthUrl();
    return res.json({ authUrl });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
