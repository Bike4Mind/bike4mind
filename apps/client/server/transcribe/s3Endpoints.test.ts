import { describe, expect, it } from 'vitest';
import { browserPresignConfig, storageClientConfig } from './s3Endpoints';

describe('storageClientConfig', () => {
  it('leaves the SDK defaults alone when no custom endpoint is set', () => {
    expect(storageClientConfig({})).toEqual({});
    expect(storageClientConfig({ AWS_ENDPOINT_URL_S3: '  ' })).toEqual({});
  });

  it('addresses a custom endpoint path-style', () => {
    expect(storageClientConfig({ AWS_ENDPOINT_URL_S3: 'http://minio:9000' })).toEqual({
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
    });
  });
});

describe('browserPresignConfig', () => {
  it('is null without a browser-facing endpoint, so the server client signs', () => {
    expect(browserPresignConfig({ AWS_ENDPOINT_URL_S3: 'http://minio:9000' })).toBeNull();
  });

  it('signs against the browser-facing endpoint, path-style', () => {
    expect(browserPresignConfig({ S3_PRESIGN_ENDPOINT: ' http://localhost:9000 ' })).toEqual({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    });
  });
});
