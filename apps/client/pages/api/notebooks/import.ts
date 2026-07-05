import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';
import { z } from 'zod';

const ImportOptionsSchema = z.object({
  conflictResolution: z.enum(['skip', 'overwrite', 'rename', 'merge']).prefault('rename'),
  preserveIds: z.boolean().prefault(false),
  importKnowledge: z.boolean().prefault(true),
  importArtifacts: z.boolean().prefault(true),
  importTools: z.boolean().prefault(true),
  importAgents: z.boolean().prefault(true),
  namePrefix: z.string().optional(),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    if (!req.ability?.can(Permission.create, Session)) {
      return res.status(403).json({
        success: false,
        message: 'Cannot create sessions',
      });
    }

    const options = ImportOptionsSchema.parse(req.body);

    const bucket = Resource.historyImportBucket.name; // reuses the history-import bucket
    const s3 = new S3Storage(bucket);

    // notebooks/ prefix distinguishes these from OpenAI/Claude imports
    const timestamp = Date.now();
    const dataKey = `notebooks/${userId}/${timestamp}.json`;
    const optionsKey = `notebooks/${userId}/${timestamp}.options.json`;

    // options are stored in S3 so the import Lambda can read them
    const optionsBuffer = Buffer.from(JSON.stringify(options), 'utf-8');
    await s3.upload(optionsBuffer, optionsKey, { ContentType: 'application/json' });

    const uploadUrl = await s3.getSignedUrl(dataKey, 'put', {
      expiresIn: 600,
    });

    req.logger.info('Generated presigned URL for notebook import', {
      userId,
      dataKey,
      optionsKey,
    });

    return res.json({
      success: true,
      uploadUrl,
      importId: timestamp,
    });
  })
);

export default handler;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb', // body only carries options now, the file itself goes via presigned upload
    },
    externalResolver: true,
  },
};
