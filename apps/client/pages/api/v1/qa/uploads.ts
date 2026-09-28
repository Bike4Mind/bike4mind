import { requestQaUploadsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireQaIngestKey } from '@server/qa/requireQaIngestKey';
import { planUploads } from '@server/qa/planUploads';
import { getQaArtifactsBucketName, getQaS3Client, presignQaPut } from '@server/qa/storage';

/** POST /api/v1/qa/uploads. Contract: b4m-core/common/src/api-contract/contracts/qa.contract.ts. */
const handler = nextRouteForContract(requestQaUploadsContract).post(async (req, res) => {
  requireQaIngestKey(req);
  const bucket = getQaArtifactsBucketName();
  const result = await planUploads(req.validated, {
    presign: (key, contentType, bytes) => presignQaPut({ client: getQaS3Client(), bucket, key, contentType, bytes }),
  });
  return res.status(200).json(result);
});

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '256kb' } },
};

export default handler;
