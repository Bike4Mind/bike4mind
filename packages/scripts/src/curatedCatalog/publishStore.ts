import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';

export const CURATED_PREFIX = 'model-hub/curated-v2/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const LATEST_CACHE_CONTROL = 'public, max-age=300';

export interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}

export type PutCondition = { ifNoneMatch: '*' } | { ifMatch: string } | null;

/** Where the publish script reads live state and writes; keys are relative to the bucket root. */
export interface PublishStore {
  get(key: string): Promise<StoredObject | null>;
  /** 'conflict' when the condition failed: the object exists (`ifNoneMatch`) or changed (`ifMatch`). */
  put(key: string, bytes: Uint8Array, cacheControl: string, condition: PutCondition): Promise<'ok' | 'conflict'>;
  invalidate(paths: string[]): Promise<void>;
}

const status = (error: unknown) => (error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined);

/**
 * The S3 and CloudFront adapter. The bucket and distribution id are kept inside it and never reach a log line;
 * errors are rethrown as their name and HTTP status only, since SDK messages can carry the bucket name.
 */
export function s3PublishStore(
  s3: S3Client,
  cloudFront: CloudFrontClient,
  bucket: string,
  distributionId: string
): PublishStore {
  const scrubbed = (action: string, key: string, error: unknown) => {
    const name = error instanceof Error ? error.name : 'error';
    return new Error(`${action} ${key} failed: ${name} (HTTP ${status(error) ?? '?'})`);
  };
  return {
    async get(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!out.Body || !out.ETag) throw new Error('empty response');
        return { bytes: await out.Body.transformToByteArray(), etag: out.ETag };
      } catch (error) {
        if (status(error) === 404) return null;
        throw scrubbed('reading', key, error);
      }
    },
    async put(key, bytes, cacheControl, condition) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: 'application/json',
            CacheControl: cacheControl,
            ...(condition && 'ifNoneMatch' in condition ? { IfNoneMatch: condition.ifNoneMatch } : {}),
            ...(condition && 'ifMatch' in condition ? { IfMatch: condition.ifMatch } : {}),
          })
        );
        return 'ok';
      } catch (error) {
        // 409 is S3's answer when a concurrent conditional write to the same key won.
        if (condition && (status(error) === 412 || status(error) === 409)) return 'conflict';
        throw scrubbed('writing', key, error);
      }
    },
    async invalidate(paths) {
      try {
        await cloudFront.send(
          new CreateInvalidationCommand({
            DistributionId: distributionId,
            InvalidationBatch: {
              CallerReference: `curated-${Date.now()}`,
              Paths: { Quantity: paths.length, Items: paths },
            },
          })
        );
      } catch (error) {
        throw new Error(`invalidation failed: ${error instanceof Error ? error.name : 'error'}`);
      }
    },
  };
}
