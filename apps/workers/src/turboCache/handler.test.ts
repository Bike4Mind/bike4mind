import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockSend = vi.fn();
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://s3.example.com/presigned');
vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = mockSend;
  }
  return {
    S3Client: MockS3Client,
    GetObjectCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    PutObjectCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    HeadObjectCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('sst', () => ({
  Resource: {
    turboCacheBucket: { name: 'test-turbo-cache-bucket' },
    TURBO_CACHE_TOKEN: { value: 'test-token-abc123' },
  },
}));

function makeEvent(
  overrides: Partial<APIGatewayProxyEventV2> & { method?: string; path?: string }
): APIGatewayProxyEventV2 {
  const { method = 'GET', path = '/', ...rest } = overrides;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer test-token-abc123' },
    queryStringParameters: undefined,
    requestContext: {
      accountId: '123',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...rest,
  } as APIGatewayProxyEventV2;
}

describe('turboCache handler', () => {
  let handler: typeof import('./handler').handler;

  beforeEach(async () => {
    vi.clearAllMocks();
    handler = (await import('./handler')).handler;
  });

  it('rejects requests without a valid token', async () => {
    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123', headers: {} });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it('rejects requests with a wrong token', async () => {
    const event = makeEvent({
      method: 'GET',
      path: '/v8/artifacts/abc123',
      headers: { authorization: 'Bearer wrong-token' },
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it('returns 404 for unknown paths', async () => {
    const event = makeEvent({ method: 'GET', path: '/unknown' });
    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });

  it('accepts POST /v8/artifacts/events', async () => {
    const event = makeEvent({ method: 'POST', path: '/v8/artifacts/events', body: '{}' });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  it('returns 302 redirect on GET hit', async () => {
    mockSend.mockResolvedValueOnce({ ContentLength: 1024 });

    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(302);
    expect(result.headers?.location).toBe('https://s3.example.com/presigned');
    expect(mockGetSignedUrl).toHaveBeenCalledOnce();
  });

  it('returns 404 on GET miss', async () => {
    const err = new Error('not found');
    (err as Error & { name: string }).name = 'NotFound';
    mockSend.mockRejectedValueOnce(err);

    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('returns 307 redirect on PUT', async () => {
    const event = makeEvent({
      method: 'PUT',
      path: '/v8/artifacts/abc123def456',
      body: Buffer.from('new-data').toString('base64'),
      isBase64Encoded: true,
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(307);
    expect(result.headers?.location).toBe('https://s3.example.com/presigned');
    expect(mockGetSignedUrl).toHaveBeenCalledOnce();
  });

  it('returns 200 on HEAD hit', async () => {
    mockSend.mockResolvedValueOnce({ ContentLength: 42 });

    const event = makeEvent({ method: 'HEAD', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-length']).toBe('42');
  });

  it('returns 404 on HEAD miss', async () => {
    const err = new Error('not found');
    (err as Error & { name: string }).name = 'NotFound';
    mockSend.mockRejectedValueOnce(err);

    const event = makeEvent({ method: 'HEAD', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('rethrows unexpected S3 errors on HEAD', async () => {
    const err = new Error('InternalError');
    (err as Error & { name: string }).name = 'InternalError';
    mockSend.mockRejectedValueOnce(err);

    const event = makeEvent({ method: 'HEAD', path: '/v8/artifacts/abc123def456' });
    await expect(handler(event)).rejects.toThrow('InternalError');
  });

  it('rethrows unexpected S3 errors on GET', async () => {
    const err = new Error('InternalError');
    (err as Error & { name: string }).name = 'InternalError';
    mockSend.mockRejectedValueOnce(err);

    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123def456' });
    await expect(handler(event)).rejects.toThrow('InternalError');
  });

  it('namespaces artifacts by team slug', async () => {
    const event = makeEvent({
      method: 'PUT',
      path: '/v8/artifacts/abc123def456',
      body: 'data',
      queryStringParameters: { slug: 'bike4mind' },
    });
    await handler(event);

    const putCmd = mockGetSignedUrl.mock.calls[0][1];
    expect(putCmd.input.Key).toBe('bike4mind/abc123def456');
  });

  it('returns 405 for unsupported methods', async () => {
    const event = makeEvent({ method: 'DELETE', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});
