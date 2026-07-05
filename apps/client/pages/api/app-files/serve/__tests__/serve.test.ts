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
    appFilesBucket: { name: 'test-app-files-bucket' },
    generatedImagesBucket: { name: 'test-generated-images-bucket' },
  },
}));

import handlerImpl from '../[...key]';
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
      query: { key: ['generated', 'abc.png'] },
      headers: {},
    } as unknown as NextApiRequest;
    const { res, headers } = makeRes();
    await handler(req, res);

    const call = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
    expect(call.Key).toBe('abc.png'); // 'generated/' stripped
    expect(headers['Content-Type']).toBe('image/png');
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(1);
  });

  it('returns 404 and makes no S3 call when NEXT_PUBLIC_CDN_URL is not the local proxy base', async () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://files.bike4mind.com';
    const req = { method: 'GET', query: { key: ['generated', 'abc.png'] }, headers: {} } as unknown as NextApiRequest;
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
      query: { key: ['generated', 'missing.png'] },
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
      query: { key: ['generated', 'big.png'] },
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
