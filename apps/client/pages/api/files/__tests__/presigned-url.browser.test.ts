import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from '../../../../../../b4m-core/fab-pipeline/src/storage/S3Storage';

const h = vi.hoisted(() => ({ findOne: vi.fn(), findAccessibleById: vi.fn(), options: undefined as unknown }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.options = options;
    return { get: (handler: unknown) => handler };
  },
}));
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'files-bucket' } } }));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: (...args: unknown[]) => ({ lean: () => h.findOne(...args) }) },
  fabFileRepository: { shareable: { findAccessibleById: (...args: unknown[]) => h.findAccessibleById(...args) } },
}));
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: vi.fn(async () => []),
  isFileInAccessibleLake: vi.fn(),
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => new S3Storage('files-bucket', 'us-east-2') }));

let handler: (req: unknown, res: unknown) => Promise<void>;

function signature(url: URL, secret = 'fixture-secret') {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const date = url.searchParams.get('X-Amz-Date')!;
  const scope = `${date.slice(0, 8)}/us-east-2/s3/aws4_request`;
  const canonical = ['GET', url.pathname, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(date.slice(0, 8)).digest();
  const regionKey = createHmac('sha256', dateKey).update('us-east-2').digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  return createHmac('sha256', signingKey).update(toSign).digest('hex');
}

async function urls(filePaths: string[], expiresIn = '600') {
  const json = vi.fn();
  await handler({ query: { 'filePaths[]': filePaths, expiresIn }, user: { id: 'owner' } }, { json });
  return json.mock.calls[0][0].urls as (string | null)[];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv('AWS_REGION', 'us-east-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fixture-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');
  vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://objects.example.invalid:9443');
  h.findOne.mockResolvedValue({ _id: 'file-1', moderationStatus: 'clean' });
  h.findAccessibleById.mockResolvedValue(true);
  handler = (await import('../presigned-url')).default as unknown as typeof handler;
});
afterEach(() => vi.unstubAllEnvs());

describe('generic file browser download signing', () => {
  it('returns a valid signature for the browser origin, exact decoded key and requested expiry', async () => {
    const url = new URL((await urls(['owned/folder%20name/report.txt']))[0]!);
    expect(url.origin).toBe('https://objects.example.invalid:9443');
    expect(url.pathname).toBe('/files-bucket/owned/folder%20name/report.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(signature(url));
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(signature(url, 'wrong-secret'));
    const rewritten = new URL(url);
    rewritten.host = 'minio.internal:9000';
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(signature(rewritten));
    const privateUrl = new URL(await new S3Storage('files-bucket').getSignedUrl('owned/report.txt'));
    expect(privateUrl.origin).toBe('http://minio.internal:9000');
  });

  it('retains configured private signing when the browser override is unset', async () => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
    expect(new URL((await urls(['owned/report.txt']))[0]!).origin).toBe('http://minio.internal:9000');
  });

  it('retains AWS addressing when neither custom endpoint is configured', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
    vi.stubEnv('S3_PRESIGN_ENDPOINT', '');
    vi.resetModules();
    handler = (await import('../presigned-url')).default as unknown as typeof handler;
    expect(new URL((await urls(['owned/report.txt']))[0]!).hostname).toBe('files-bucket.s3.us-east-2.amazonaws.com');
  });

  it('withholds inaccessible, held and unknown keys before signing while preserving positions', async () => {
    h.findOne.mockImplementation(async ({ filePath }: { filePath: string }) =>
      filePath === 'unknown' ? null : { _id: filePath, moderationStatus: filePath === 'held' ? 'pending' : 'clean' }
    );
    h.findAccessibleById.mockImplementation(async (_user: unknown, id: string) => id === 'owned');
    const result = await urls(['owned', 'foreign', 'held', 'unknown']);
    expect(result[0]).toEqual(expect.any(String));
    expect(result.slice(1)).toEqual([null, null, null]);
    expect(h.options).toEqual({ requiredScopes: ['files:read'] });
  });
});
