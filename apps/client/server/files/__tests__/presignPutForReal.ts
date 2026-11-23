import { vi } from 'vitest';
import type { PutObjectCommandInput } from '@aws-sdk/client-s3';
import type { getSignedUrl as GetSignedUrl } from '@aws-sdk/s3-request-presigner';

type PresignOptions = Parameters<typeof GetSignedUrl>[2];

/**
 * Re-signs a PUT with the real AWS SDK, from the exact command input and presign options a door
 * handed to its (mocked) getSignedUrl, so a test can read what the URL actually binds. The door
 * tests mock the SDK; this bypasses those mocks with importActual. Mirrors createS3Client's config, which
 * it cannot call (the mocked client-s3 would reach it); allowlisted in checkNoRawS3Client.repo.test.ts.
 */
export async function presignPutForReal(input: PutObjectCommandInput, options: PresignOptions): Promise<URL> {
  const { S3Client, PutObjectCommand } =
    await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  const { getSignedUrl } = await vi.importActual<typeof import('@aws-sdk/s3-request-presigner')>(
    '@aws-sdk/s3-request-presigner'
  );
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return new URL(await getSignedUrl(client, new PutObjectCommand(input), options));
}

/** The header names a presigned URL's signature covers. */
export function signedHeaders(url: URL): string[] {
  return (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
}
