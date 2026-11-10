import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockSend = vi.fn();
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

  it('returns artifact on GET hit', async () => {
    const content = Buffer.from('cached-data');
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(content) },
      ContentLength: content.length,
    });

    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body!, 'base64').toString()).toBe('cached-data');
  });

  it('returns 404 on GET miss', async () => {
    const err = new Error('not found');
    (err as Error & { name: string }).name = 'NoSuchKey';
    mockSend.mockRejectedValueOnce(err);

    const event = makeEvent({ method: 'GET', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('uploads artifact on PUT', async () => {
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      method: 'PUT',
      path: '/v8/artifacts/abc123def456',
      body: Buffer.from('new-data').toString('base64'),
      isBase64Encoded: true,
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(202);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('returns 200 on HEAD hit', async () => {
    mockSend.mockResolvedValueOnce({ ContentLength: 42 });

    const event = makeEvent({ method: 'HEAD', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-length']).toBe('42');
  });

  it('namespaces artifacts by team slug', async () => {
    mockSend.mockResolvedValueOnce({});

    const event = makeEvent({
      method: 'PUT',
      path: '/v8/artifacts/abc123def456',
      body: 'data',
      queryStringParameters: { slug: 'bike4mind' },
    });
    await handler(event);

    const putCmd = mockSend.mock.calls[0][0];
    expect(putCmd.input.Key).toBe('bike4mind/abc123def456');
  });

  it('returns 405 for unsupported methods', async () => {
    const event = makeEvent({ method: 'DELETE', path: '/v8/artifacts/abc123def456' });
    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});
