import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { s3PublishStore } from './publishStore';

const BUCKET = 'test-bucket-name-xyz';
const DISTRIBUTION = 'EDISTRIBUTIONID01';
const s3 = mockClient(S3Client);
const cloudFront = mockClient(CloudFrontClient);
const store = () => s3PublishStore(createS3Client({}), new CloudFrontClient({}), BUCKET, DISTRIBUTION);

const failure = (name: string, status: number) =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: `${name} in ${BUCKET}`,
  });

beforeEach(() => {
  s3.reset();
  cloudFront.reset();
});

describe('s3PublishStore', () => {
  it('reads an object with its ETag, and a missing one as null', async () => {
    s3.on(GetObjectCommand, { Key: 'k/latest.json' }).resolves({
      // Only the method the adapter calls; a real SDK stream needs the smithy mixin this package does not depend on.
      Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('{}')) } as never,
      ETag: '"abc"',
    });
    s3.on(GetObjectCommand, { Key: 'k/none.json' }).rejects(failure('NoSuchKey', 404));
    expect(await store().get('k/latest.json')).toEqual({ bytes: new Uint8Array(Buffer.from('{}')), etag: '"abc"' });
    expect(await store().get('k/none.json')).toBeNull();
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({ Bucket: BUCKET, Key: 'k/latest.json' });
  });

  it('writes JSON with the cache policy and the condition, and reports a failed condition as a conflict', async () => {
    s3.on(PutObjectCommand, { Key: 'k/1.json' }).resolves({});
    s3.on(PutObjectCommand, { Key: 'k/latest.json.sig' }).rejects(failure('PreconditionFailed', 412));
    const bytes = new Uint8Array([1, 2]);
    expect(await store().put('k/1.json', bytes, 'immutable-policy', { ifNoneMatch: '*' })).toBe('ok');
    expect(await store().put('k/latest.json.sig', bytes, 'short', { ifMatch: '"e1"' })).toBe('conflict');
    expect(s3.commandCalls(PutObjectCommand).map(call => call.args[0].input)).toEqual([
      {
        Bucket: BUCKET,
        Key: 'k/1.json',
        Body: bytes,
        ContentType: 'application/json',
        CacheControl: 'immutable-policy',
        IfNoneMatch: '*',
      },
      {
        Bucket: BUCKET,
        Key: 'k/latest.json.sig',
        Body: bytes,
        ContentType: 'application/json',
        CacheControl: 'short',
        IfMatch: '"e1"',
      },
    ]);
  });

  it('never lets the bucket name or distribution id into an error', async () => {
    s3.on(PutObjectCommand).rejects(failure('AccessDenied', 403));
    s3.on(GetObjectCommand).rejects(failure('AccessDenied', 403));
    cloudFront.on(CreateInvalidationCommand).rejects(new Error(`no such distribution ${DISTRIBUTION}`));
    const message = (error: Error) => error.message;
    const errors = await Promise.all([
      store().put('k/latest.json', new Uint8Array(), 'short', null).catch(message),
      store().get('k/latest.json').catch(message),
      store().invalidate(['/k/latest.json']).catch(message),
    ]);
    expect(errors).toEqual([
      'writing k/latest.json failed: AccessDenied (HTTP 403)',
      'reading k/latest.json failed: AccessDenied (HTTP 403)',
      'invalidation failed: Error',
    ]);
    for (const message of errors) expect(message).not.toMatch(new RegExp(`${BUCKET}|${DISTRIBUTION}`));
  });

  it('invalidates exactly the paths given', async () => {
    cloudFront.on(CreateInvalidationCommand).resolves({});
    await store().invalidate(['/k/latest.json', '/k/latest.json.sig']);
    const input = cloudFront.commandCalls(CreateInvalidationCommand)[0].args[0].input;
    expect(input.DistributionId).toBe(DISTRIBUTION);
    expect(input.InvalidationBatch?.Paths).toEqual({ Quantity: 2, Items: ['/k/latest.json', '/k/latest.json.sig'] });
  });
});
