import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Every PutObject-capable S3Client must set requestChecksumCalculation to WHEN_REQUIRED. The
 * SDK's flexible-checksums middleware (default since @aws-sdk/client-s3 3.729.0) replaces
 * content-length with x-amz-decoded-content-length on outgoing requests, which disagrees with
 * the SigV4 payload hash on PutObject and fails with XAmzContentSHA256Mismatch (#1535). Route
 * every construction site through this helper instead of `new S3Client()` directly so a new
 * PutObject path can't reintroduce the bug - checkNoRawS3Client.test.ts enforces that.
 */
export function createS3Client(config: S3ClientConfig = {}): S3Client {
  return new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' });
}
