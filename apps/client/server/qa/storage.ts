import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { getQaArtifactsStorage } from '@server/utils/storage';

export { getQaArtifactsBucketName } from '@server/utils/storage';

export const QA_PUT_EXPIRY_SECONDS = 900;
export const QA_GET_EXPIRY_SECONDS = 3600;

let _client: S3Client | undefined;

/** Same endpoint handling as S3Storage (b4m-core/fab-pipeline/src/storage/S3Storage.ts), so self-host MinIO works. */
export const getQaS3Client = (): S3Client => {
  if (!_client) {
    const endpoint = process.env.AWS_ENDPOINT_URL_S3;
    _client = createS3Client({
      region: process.env.AWS_REGION || 'us-east-2',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }
  return _client;
};

/**
 * ContentLength and ContentType become signed headers, so S3 rejects a PUT of
 * any other size or type. That is the per-kind size cap; S3Storage.getSignedUrl
 * cannot bind length, hence this helper. The presigner signs content-length on
 * its own but leaves content-type unsigned unless named in `signableHeaders`.
 * The client must come from createS3Client: its WHEN_REQUIRED checksum setting
 * keeps the SDK from signing a checksum header the CI script never sends.
 */
export async function presignQaPut(args: {
  client: S3Client;
  bucket: string;
  key: string;
  contentType: string;
  bytes: number;
  expiresIn?: number;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: args.bucket,
    Key: args.key,
    ContentType: args.contentType,
    ContentLength: args.bytes,
  });
  return getSignedUrl(args.client, command, {
    expiresIn: args.expiresIn ?? QA_PUT_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
}

export interface QaMediaStorage {
  exists(key: string): Promise<boolean>;
  signedGetUrl(key: string): Promise<string>;
}

export function qaMediaStorage(): QaMediaStorage {
  const storage = getQaArtifactsStorage();
  return {
    exists: async key => {
      try {
        await storage.getMetadata(key);
        return true;
      } catch {
        return false;
      }
    },
    signedGetUrl: key => storage.getSignedUrl(key, 'get', { expiresIn: QA_GET_EXPIRY_SECONDS }),
  };
}
