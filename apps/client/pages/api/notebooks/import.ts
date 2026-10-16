import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { resolveBrowserNotebookImportUploadUrl } from '@server/utils/browserUploadUrl';
import { buildNotebookImportKeys } from '@server/utils/notebookImportKeys';
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

// Same ceiling as the history-import upload that shares this bucket (MAX_HISTORY_UPLOAD_BYTES).
const MAX_NOTEBOOK_IMPORT_BYTES = 1024 * 1024 * 1024; // 1 GB

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
    // The upload's byte length: the hosted PUT is bound to it (S3 refuses any other length).
    const { size } = z.object({ size: z.number().int().positive().max(MAX_NOTEBOOK_IMPORT_BYTES) }).parse(req.body);

    const bucket = Resource.historyImportBucket.name; // reuses the history-import bucket
    const s3 = new S3Storage(bucket);

    const timestamp = Date.now();
    const { dataKey, optionsKey } = buildNotebookImportKeys(String(userId), String(timestamp));

    // options are stored in S3 so the import Lambda can read them
    const optionsBuffer = Buffer.from(JSON.stringify(options), 'utf-8');
    await s3.upload(optionsBuffer, optionsKey, { ContentType: 'application/json' });

    let uploadUrl = '';
    if (process.env.B4M_SELF_HOST !== 'true') {
      uploadUrl = await s3.getSignedUrl(dataKey, 'put', { expiresIn: 600, ContentLength: size });
    }

    req.logger.info('Prepared notebook import upload', {
      userId,
      dataKey,
      optionsKey,
    });

    // Self-host gets the same-origin proxy below; hosted keeps the presign untouched.
    return res.json({
      success: true,
      uploadUrl: resolveBrowserNotebookImportUploadUrl(String(timestamp), uploadUrl),
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
