import { S3Storage } from '@bike4mind/fab-pipeline';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Resource } from 'sst';
import { z } from 'zod';

const AppFileGetUrlRequestInput = z.object({
  path: z.string(),
});

const handler = baseApi().post(
  asyncHandler<unknown, string>(async (req, res) => {
    const data = AppFileGetUrlRequestInput.parse(req.body);

    const storage = new S3Storage(Resource.appFilesBucket.name);
    const url = await storage.getSignedUrl(data.path);

    return res.json(url);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
