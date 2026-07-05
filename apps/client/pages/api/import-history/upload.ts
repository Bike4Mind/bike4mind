import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { importHistoryService } from '@bike4mind/services';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

interface IParams {
  source: string;
}

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
    const { source } = req.query;
    if (source !== importHistoryService.ImportSource.OPENAI && source !== importHistoryService.ImportSource.CLAUDE) {
      throw new Error('Invalid source');
    }

    if (!req.ability?.can(Permission.create, Session)) throw new Error('Cannot create session');

    const bucket = Resource.historyImportBucket.name;
    const s3 = new S3Storage(bucket);
    const key = `${req.user?.id}/${source}/${Date.now()}.zip`;
    const url = await s3.getSignedUrl(key, 'put', { expiresIn: 600 });

    return res.json({ success: true, url });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
