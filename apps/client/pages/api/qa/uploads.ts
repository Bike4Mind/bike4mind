import { ApiKeyScope, QaUploadRequestSchema } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireQaIngestKey } from '@server/qa/requireQaIngestKey';
import { planUploads } from '@server/qa/planUploads';
import { getQaArtifactsBucketName, getQaS3Client, presignQaPut } from '@server/qa/storage';

/** POST /api/qa/uploads. Internal CI ingest like ./runs.ts (same auth, same 422 on a bad body). */
const handler = baseApi({ requiredScopes: [ApiKeyScope.QA_INGEST] }).post(async (req, res) => {
  requireQaIngestKey(req);
  const body = QaUploadRequestSchema.parse(req.body);
  const bucket = getQaArtifactsBucketName();
  const result = await planUploads(body, {
    presign: (key, contentType, bytes) => presignQaPut({ client: getQaS3Client(), bucket, key, contentType, bytes }),
  });
  return res.status(200).json(result);
});

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '256kb' } },
};

export default handler;
