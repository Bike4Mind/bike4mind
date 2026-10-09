import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from './S3Storage';

function expectedGetSignature(url: URL, secret = 'fixture-secret-key'): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const date = url.searchParams.get('X-Amz-Date')!;
  const scope = `${date.slice(0, 8)}/us-east-2/s3/aws4_request`;
  const canonical = ['GET', url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join(
    '\n'
  );
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(date.slice(0, 8)).digest();
  const regionKey = createHmac('sha256', dateKey).update('us-east-2').digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');
  vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('S3Storage browser-facing signing endpoint', () => {
  it('signs the public origin with the exact key, expiry and download disposition', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid:9443');
    const storage = new S3Storage('exports-bucket', 'us-east-2');
    const disposition = 'attachment; filename="quest plan.zip"';
    const url = new URL(
      await storage.getSignedUrl('exports/quest plan/artifact.zip', 'get', {
        audience: 'browser',
        expiresIn: 600,
        ResponseContentDisposition: disposition,
      })
    );

    expect(url.origin).toBe('https://objects.example.invalid:9443');
    expect(url.pathname).toBe('/exports-bucket/exports/quest%20plan/artifact.zip');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^fixture-access-key\/\d{8}\/us-east-2\/s3\/aws4_request$/
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    expect(url.searchParams.get('response-content-disposition')).toBe(disposition);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedGetSignature(url));
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(expectedGetSignature(url, 'wrong-secret'));
  });

  it('uses the configured signing origin for PUT capabilities too', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'http://localhost:19000');
    const url = new URL(
      await new S3Storage('exports-bucket').getSignedUrl('uploads/fixture.txt', 'put', {
        expiresIn: 90,
        audience: 'browser',
      })
    );
    expect(url.origin).toBe('http://localhost:19000');
    expect(url.pathname).toBe('/exports-bucket/uploads/fixture.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('90');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps server signing private when a browser endpoint is configured', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'http://localhost:19000');
    const storage = new S3Storage('exports-bucket', 'us-east-2');
    const url = new URL(await storage.getSignedUrl('artifact.zip'));
    expect(url.origin).toBe('http://minio.internal:9000');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(expectedGetSignature(url));
  });

  it.each(['objects.example.invalid', 'localhost:9000', 'ftp://objects.example.invalid'])(
    'rejects invalid browser endpoint %s with the configuration variable name',
    endpoint => {
      vi.stubEnv('S3_PRESIGN_ENDPOINT', endpoint);
      expect(() => new S3Storage('exports-bucket')).toThrow('S3_PRESIGN_ENDPOINT');
    }
  );

  it('keeps the current custom endpoint when the signing override is unset', async () => {
    const url = new URL(await new S3Storage('exports-bucket').getSignedUrl('artifact.zip'));
    expect(url.origin).toBe('http://minio.internal:9000');
    expect(url.pathname).toBe('/exports-bucket/artifact.zip');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('keeps the hosted S3 origin when both endpoint overrides are unset', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
    const url = new URL(await new S3Storage('exports-bucket', 'us-east-2').getSignedUrl('artifact.zip'));
    expect(url.origin).toBe('https://exports-bucket.s3.us-east-2.amazonaws.com');
    expect(url.pathname).toBe('/artifact.zip');
  });

  it('keeps actual SDK upload, metadata, download and delete requests on the private endpoint', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid');
    const storage = new S3Storage('exports-bucket', 'us-east-2');
    const client = (
      storage as unknown as { s3: { config: { requestHandler: { handle: (...args: unknown[]) => Promise<unknown> } } } }
    ).s3;
    const requests: Array<{ hostname: string; port?: number; method: string }> = [];
    vi.spyOn(client.config.requestHandler, 'handle').mockImplementation(async request => {
      const http = request as { hostname: string; port?: number; method: string };
      requests.push(http);
      return {
        response: {
          statusCode: 200,
          headers: { 'content-length': http.method === 'GET' ? '7' : '0', 'content-type': 'application/octet-stream' },
          body: Readable.from(http.method === 'GET' ? [Buffer.from('fixture')] : []),
        },
      };
    });

    await storage.upload(Buffer.from('fixture'), 'artifact.zip');
    await storage.getMetadata('artifact.zip');
    expect(await storage.download('artifact.zip')).toEqual(Buffer.from('fixture'));
    await storage.delete('artifact.zip');
    expect(requests.map(request => request.method)).toEqual(['PUT', 'HEAD', 'GET', 'DELETE']);
    expect(requests.every(request => request.hostname === 'minio.internal' && request.port === 9000)).toBe(true);
    expect(new URL(await storage.getSignedUrl('artifact.zip')).origin).toBe('http://minio.internal:9000');
    expect(new URL(await storage.getSignedUrl('artifact.zip', 'get', { audience: 'browser' })).origin).toBe(
      'https://objects.example.invalid'
    );
    expect(requests).toHaveLength(4);
  });
});
