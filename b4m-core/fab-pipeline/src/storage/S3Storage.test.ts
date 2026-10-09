import { describe, it, expect, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Storage } from './S3Storage';

/**
 * Regression lock for #1535: the SDK's default requestChecksumCalculation ('WHEN_SUPPORTED')
 * makes every PutObject fail with XAmzContentSHA256Mismatch (a known aws-sdk-js-v3 regression
 * from the flexible-checksums middleware added in 3.729.0). 'WHEN_REQUIRED' restores the
 * pre-3.729.0 behavior. There is no unit-testable way to observe the actual upload succeeding
 * without a real S3 endpoint, so this locks the client CONFIG instead - deleting the override
 * would silently reintroduce the bug with no other test catching it.
 */
describe('S3Storage sets requestChecksumCalculation to WHEN_REQUIRED', () => {
  it('overrides the SDK default that causes XAmzContentSHA256Mismatch', async () => {
    const storage = new S3Storage('test-bucket', 'us-east-2');
    const client = (storage as unknown as { s3: { config: { requestChecksumCalculation: () => Promise<string> } } }).s3;
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
  });
});

describe('S3Storage.upload', () => {
  it('forwards the abort signal to the SDK send', async () => {
    const storage = new S3Storage('test-bucket', 'us-east-2');
    const client = (storage as unknown as { s3: { send: (...args: unknown[]) => Promise<unknown> } }).s3;
    const send = vi.spyOn(client, 'send').mockResolvedValue({});
    const controller = new AbortController();

    await storage.upload(Buffer.from('v'), 'generated-video/j1.mp4', { ContentType: 'video/mp4' }, controller.signal);

    expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand), {
      requestTimeout: 300000,
      abortSignal: controller.signal,
    });
  });
});
