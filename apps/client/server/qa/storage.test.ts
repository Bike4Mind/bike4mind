import { describe, it, expect } from 'vitest';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { presignQaPut } from './storage';

const client = createS3Client({
  region: 'us-east-2',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret' },
});

describe('presignQaPut', () => {
  it('signs content-length so S3 rejects any other size', async () => {
    const url = new URL(
      await presignQaPut({
        client,
        bucket: 'example-bucket',
        key: 'product-a/1-1/media/test-0/a.png',
        contentType: 'image/png',
        bytes: 1234,
      })
    );
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toContain('content-length');
    expect(signed.split(';')).toContain('content-type');
    expect(url.pathname).toContain('product-a/1-1/media/test-0/a.png');
  });

  it('binds no SDK checksum the uploader would have to send', async () => {
    const url = new URL(
      await presignQaPut({ client, bucket: 'example-bucket', key: 'k', contentType: 'image/png', bytes: 1 })
    );
    const params = [...url.searchParams.keys()].map(k => k.toLowerCase());
    expect(params.filter(k => k.includes('checksum'))).toEqual([]);
  });

  it('defaults to a 15 minute expiry', async () => {
    const url = new URL(
      await presignQaPut({ client, bucket: 'example-bucket', key: 'k', contentType: 'image/png', bytes: 1 })
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });
});
