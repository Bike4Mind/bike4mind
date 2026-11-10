import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Resource } from 'sst';

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
    TURBO_CACHE_READ_TOKEN: { value: 'read-token-abc123' },
  },
}));

vi.mock('./eventsRoute', () => ({
  handleEvents: vi.fn().mockResolvedValue({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }),
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
    (Resource as unknown as Record<string, { value: string }>).TURBO_CACHE_TOKEN.value = 'test-token-abc123';
    (Resource as unknown as Record<string, { value: string }>).TURBO_CACHE_READ_TOKEN.value = 'read-token-abc123';
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

  it('returns an upload URL before the artifact body is sent', async () => {
    const event = makeEvent({
      method: 'OPTIONS',
      headers: { authorization: 'Bearer test-token-abc123', 'access-control-request-method': 'PUT' },
      path: '/v8/artifacts/abc123def456',
      body: Buffer.from('new-data').toString('base64'),
      isBase64Encoded: true,
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['access-control-allow-headers']).not.toMatch(/authorization|\*/i);
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
      method: 'OPTIONS',
      headers: { authorization: 'Bearer test-token-abc123', 'access-control-request-method': 'PUT' },
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
  it.each(['PUT', 'OPTIONS'])('denies read-only %s uploads without signing a URL', async method => {
    const result = await handler(
      makeEvent({
        method,
        path: '/v8/artifacts/abc123',
        headers: { authorization: 'Bearer read-token-abc123', 'access-control-request-method': 'PUT' },
      })
    );
    expect(result.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects direct uploads with an actionable preflight error', async () => {
    const result = await handler(makeEvent({ method: 'PUT', path: '/v8/artifacts/abc123' }));
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('remoteCache.preflight');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('keeps %s preflight at Lambda for reads and metadata', async method => {
    const result = await handler(
      makeEvent({
        method: 'OPTIONS',
        path: '/v8/artifacts/abc123',
        headers: { authorization: 'Bearer read-token-abc123', 'access-control-request-method': method },
      })
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.location).toBeUndefined();
    expect(result.headers?.['access-control-allow-headers']).toContain('Authorization');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('accepts authenticated analytics preflight', async () => {
    const result = await handler(
      makeEvent({
        method: 'OPTIONS',
        path: '/v8/artifacts/events',
        headers: { authorization: 'Bearer read-token-abc123', 'access-control-request-method': 'POST' },
      })
    );
    expect(result.statusCode).toBe(200);
  });

  it.each([undefined, 'DELETE'])('rejects invalid preflight methods (%s)', async method => {
    const result = await handler(
      makeEvent({
        method: 'OPTIONS',
        path: '/v8/artifacts/abc123',
        headers: { authorization: 'Bearer test-token-abc123', 'access-control-request-method': method },
      })
    );
    expect(result.statusCode).toBe(405);
  });

  it.each(['test-token-abc123', 'Bearer \u00e9est-token-abc123', 'Bearer test-token-abc123 extra'])(
    'rejects malformed credentials without throwing (%s)',
    async authorization => {
      const result = await handler(makeEvent({ path: '/v8/artifacts/abc123', headers: { authorization } }));
      expect(result.statusCode).toBe(401);
    }
  );

  it('denies unconfigured tokens', async () => {
    const secrets = Resource as unknown as Record<string, { value: string }>;
    secrets.TURBO_CACHE_TOKEN.value = 'not-configured';
    secrets.TURBO_CACHE_READ_TOKEN.value = 'not-configured';
    const result = await handler(
      makeEvent({ path: '/v8/artifacts/abc123', headers: { authorization: 'Bearer not-configured' } })
    );
    expect(result.statusCode).toBe(401);
  });

  it('fails closed when read and write secrets are identical', async () => {
    (Resource as unknown as Record<string, { value: string }>).TURBO_CACHE_READ_TOKEN.value = 'test-token-abc123';
    const result = await handler(makeEvent({ method: 'PUT', path: '/v8/artifacts/abc123' }));
    expect(result.statusCode).toBe(403);
  });

  it.each(['GET', 'HEAD'])('allows read-only %s hits', async method => {
    mockSend.mockResolvedValueOnce({ ContentLength: 42 });
    const result = await handler(
      makeEvent({ method, path: '/v8/artifacts/abc123', headers: { authorization: 'Bearer read-token-abc123' } })
    );
    expect(result.statusCode).toBe(method === 'GET' ? 302 : 200);
  });
});
