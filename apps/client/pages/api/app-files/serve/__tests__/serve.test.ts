import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';

const s3Mock = mockClient(S3Client);

// baseApi wraps the handler; in dev the route is auth:false, so a thin
// pass-through mock keeps the test focused on routing + streaming.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: unknown) => h }),
}));

// SST Resource is not available in test environments - mock the bucket names.
vi.mock('sst', () => ({
  Resource: {
    JWT_SECRET: { value: 'test-jwt-secret' },
    appFilesBucket: { name: 'test-app-files-bucket' },
    generatedImagesBucket: { name: 'test-generated-images-bucket' },
  },
}));

import { signGeneratedMediaUrlToken } from '@bike4mind/server-utils/utils/generatedMediaUrlToken';
import handlerImpl from '../[...key]';

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (key: string, exp = nowSec() + 60) => signGeneratedMediaUrlToken({ key, exp });
// The mock reduces baseApi to a pass-through; cast to avoid express/NextApiRequest mismatch in tests.
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeRes() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    },
    end(body?: unknown) {
      if (body) chunks.push(Buffer.from(body as string));
    },
    write(chunk: Buffer) {
      chunks.push(Buffer.from(chunk));
    },
    on() {},
    once() {},
    emit() {},
  } as unknown as NextApiResponse & { statusCode: number };
  return { res, headers, body: () => Buffer.concat(chunks) };
}

describe('GET /api/app-files/serve/[...key]', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.NEXT_PUBLIC_CDN_URL = '/api/app-files/serve';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_CDN_URL;
  });

  it('streams a generated image from the generated bucket with its content-type', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('IMGDATA')]) as never,
      ContentType: 'image/png',
      ContentLength: 7,
    });

    const req = {
      method: 'GET',
      query: { key: ['generated', 'abc.png'], t: tokenFor('abc.png') },
      headers: {},
    } as unknown as NextApiRequest;
    const { res, headers } = makeRes();
    await handler(req, res);

    const call = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(call.Key).toBe('abc.png'); // 'generated/' stripped
    expect(call.Bucket).toBe('test-generated-images-bucket');
    expect(headers['Content-Type']).toBe('image/png');
    // Inert-document backstop: kept in sync with the CDN CSP in infra/router.ts.
    expect(headers['Content-Security-Policy']).toBe("default-src 'none'; sandbox allow-downloads");
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(1);
  });

  it('answers every bad generated-media token identically and never calls S3', async () => {
    const good = tokenFor('abc.png');
    const [payload] = good.split('.');
    const cases: Record<string, unknown> = {
      missing: undefined,
      array: [good, good],
      empty: '',
      garbage: 'not-a-token',
      tamperedMac: `${payload}.${'A'.repeat(43)}`,
      expired: tokenFor('abc.png', nowSec() - 1),
      otherKey: tokenFor('other.png'),
    };
    const seen: { status: number; headers: Record<string, string>; body: string }[] = [];
    for (const t of Object.values(cases)) {
      const req = {
        method: 'GET',
        query: { key: ['generated', 'abc.png'], t },
        headers: {},
      } as unknown as NextApiRequest;
      const { res, headers, body } = makeRes();
      await handler(req, res);
      seen.push({ status: res.statusCode, headers, body: body().toString() });
    }
    expect(seen.every(r => r.status === 404 && r.body === '')).toBe(true);
    expect(new Set(seen.map(r => JSON.stringify(r))).size).toBe(1);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('does not accept a token minted for the same key on another prefix', async () => {
    const req = {
      method: 'GET',
      query: { key: ['org-files', 'abc.png'], t: tokenFor('abc.png') },
      headers: {},
    } as unknown as NextApiRequest;
    s3Mock.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
    const { res } = makeRes();
    await handler(req, res);
    const calls = s3Mock.commandCalls(GetObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({ Bucket: 'test-app-files-bucket', Key: 'organizations/abc.png' });
  });

  it.each([
    ['one encoded segment, as the signer emits', ['generated', 'u/1/x.png']],
    ['split segments', ['generated', 'u', '1', 'x.png']],
  ])('serves a generated key containing slashes (%s)', async (_label, segments) => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('X')]) as never,
      ContentType: 'image/png',
      ContentLength: 1,
    });
    const req = {
      method: 'GET',
      query: { key: segments, t: tokenFor('u/1/x.png') },
      headers: {},
    } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'test-generated-images-bucket',
      Key: 'u/1/x.png',
    });
    expect(res.statusCode).toBe(200);
  });

  it('always sends a private Cache-Control on a generated object, whatever it was stored with', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('X')]) as never,
      CacheControl: 'public, max-age=31536000',
    });
    const req = {
      method: 'GET',
      query: { key: ['generated', 'abc.png'], t: tokenFor('abc.png') },
      headers: {},
    } as unknown as NextApiRequest;
    const { res, headers } = makeRes();
    await handler(req, res);
    expect(headers['Cache-Control']).toBe('private, max-age=300');
  });

  it('returns 404 and makes no S3 call when NEXT_PUBLIC_CDN_URL is not the local proxy base', async () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://files.bike4mind.com';
    const req = {
      method: 'GET',
      query: { key: ['generated', 'abc.png'], t: tokenFor('abc.png') },
      headers: {},
    } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('returns 404 and makes no S3 call for blocked prefix transcripts/', async () => {
    const req = {
      method: 'GET',
      query: { key: ['transcripts', 'job.json'] },
      headers: {},
    } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('returns 400 for empty key', async () => {
    const req = { method: 'GET', query: { key: [] }, headers: {} } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('returns 404 when S3 rejects with NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects({ name: 'NoSuchKey' });
    const req = {
      method: 'GET',
      query: { key: ['generated', 'missing.png'], t: tokenFor('missing.png') },
      headers: {},
    } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('maps org-files path to organizations/ key in appFiles bucket', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('DATA')]) as never,
      ContentType: 'image/png',
      ContentLength: 4,
    });
    const req = {
      method: 'GET',
      query: { key: ['org-files', '123', 'logo.png'] },
      headers: {},
    } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);
    const call = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(call.Key).toBe('organizations/123/logo.png');
    expect(call.Bucket).toBe('test-app-files-bucket');
  });

  it('passes Range header to S3 and returns 206 with Content-Range when present', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('PARTIAL')]) as never,
      ContentType: 'image/png',
      ContentLength: 7,
      ContentRange: 'bytes 0-6/100',
    });
    const req = {
      method: 'GET',
      query: { key: ['generated', 'big.png'], t: tokenFor('big.png') },
      headers: { range: 'bytes=0-6' },
    } as unknown as NextApiRequest;
    const { res, headers } = makeRes();
    await handler(req, res);
    const call = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(call.Range).toBe('bytes=0-6');
    expect(headers['Content-Range']).toBe('bytes 0-6/100');
    expect(res.statusCode).toBe(206);
  });
});
