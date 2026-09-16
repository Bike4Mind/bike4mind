import { S3Storage } from '@bike4mind/fab-pipeline';
import { AppFile } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { Resource } from 'sst';
import { z } from 'zod';

const AppFileGetUrlRequestInput = z.object({
  path: z.string(),
});

const handler = baseApi().post(
  asyncHandler<unknown, string>(async (req, res) => {
    const data = AppFileGetUrlRequestInput.parse(req.body);

    // Object-level guard: `path` is a caller-supplied bucket key, so verify an AppFile row at that
    // path is owned by the caller before signing - otherwise any authenticated user could get a
    // signed URL for another user's app-file (IDOR). `path` is unique on AppFile, so this is an
    // exact ownership match; NotFoundError on missing-or-not-yours so a probe can't distinguish.
    const appFile = await AppFile.findOne({ path: data.path, userId: req.user.id });
    if (!appFile) throw new NotFoundError('App file not found');

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
