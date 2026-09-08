import { describe, it, expect } from 'vitest';
import { createS3Client } from './createS3Client';

describe('createS3Client', () => {
  it('sets requestChecksumCalculation to WHEN_REQUIRED (#1535)', async () => {
    const client = createS3Client({ region: 'us-east-2' });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('cannot be overridden by a caller-supplied config', async () => {
    const client = createS3Client({ requestChecksumCalculation: 'WHEN_SUPPORTED' });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
  });
});
