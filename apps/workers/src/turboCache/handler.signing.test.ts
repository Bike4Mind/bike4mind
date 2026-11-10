import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.mock('sst', () => ({
  Resource: {
    turboCacheBucket: { name: 'fixture-cache' },
    TURBO_CACHE_TOKEN: { value: 'fixture-write-token' },
    TURBO_CACHE_READ_TOKEN: { value: 'fixture-read-token' },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('cache upload URL signing', () => {
  it('does not bind a future artifact upload to the checksum of an empty body', async () => {
    vi.stubEnv('AWS_REGION', 'us-east-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access-key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret-key');
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
    vi.stubEnv('AWS_REQUEST_CHECKSUM_CALCULATION', 'WHEN_SUPPORTED');
    const { handler } = await import('./handler');

    const result = await handler({
      headers: {
        authorization: 'Bearer fixture-write-token',
        'access-control-request-method': 'PUT',
      },
      rawPath: '/v8/artifacts/abc123',
      requestContext: { http: { method: 'OPTIONS' } },
    } as APIGatewayProxyEventV2);

    expect(result.statusCode).toBe(200);
    const location = result.headers?.location;
    if (typeof location !== 'string') throw new Error('Missing presigned upload URL');
    const query = new URL(location).searchParams;
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect([...query.keys()].filter(key => /checksum/i.test(key))).toEqual([]);
    expect(query.get('X-Amz-SignedHeaders')?.split(';')).not.toContain('content-length');
  });
});
