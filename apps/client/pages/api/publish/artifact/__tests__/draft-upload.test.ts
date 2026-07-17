import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { PUBLISH_LIMITS } from '@bike4mind/common';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    upload: vi.fn(async () => 'ok'),
    verify: vi.fn(),
  },
}));

// Passthrough baseApi (same shape as gate/passphrase.test.ts) exposing .put().
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({ upload: mocks.upload }),
}));

vi.mock('@server/services/publish', () => ({
  verifyDraftUploadToken: (t: string) => mocks.verify(t),
}));

import handler from '../draft-upload';

interface RunArgs {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function run({ method = 'PUT', query = {}, headers = {}, body }: RunArgs) {
  const { req, res } = createMocks({ method, query, headers });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  if (body !== undefined) {
    // node-mocks-http emits `async_iterator` once the handler's `for await`
    // loop has registered its listeners; feed the raw body then.
    (req as unknown as { once: (e: string, cb: () => void) => void }).once('async_iterator', () =>
      (req as unknown as { send: (b: string | Buffer) => void }).send(body)
    );
  }
  return { req, res, promise };
}

beforeEach(() => {
  mocks.upload.mockReset().mockResolvedValue('ok');
  mocks.verify.mockReset();
  vi.stubEnv('B4M_SELF_HOST', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PUT /api/publish/artifact/draft-upload', () => {
  it('404s when not running self-host (inert on hosted stages)', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    const { res, promise } = run({ query: { token: 'anything' } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('401s when the token is missing', async () => {
    const { res, promise } = run({ query: {} });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('401s when the token is invalid or expired', async () => {
    mocks.verify.mockReturnValue(null);
    const { res, promise } = run({ query: { token: 'bad' } });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('400s on a traversal path even with a valid token (defense in depth)', async () => {
    mocks.verify.mockReturnValue({ draftId: 'd1', path: '../secret' });
    const { res, promise } = run({ query: { token: 'good' } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('streams the body to storage under the pinned draft key on a valid token', async () => {
    mocks.verify.mockReturnValue({ draftId: 'd1', path: 'index.html' });
    const { res, promise } = run({
      query: { token: 'good' },
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><h1>hi</h1>',
    });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    const [buf, key, opts] = mocks.upload.mock.calls[0] as [Buffer, string, { ContentType?: string }];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toBe('<!doctype html><h1>hi</h1>');
    expect(key).toBe('drafts/d1/index.html');
    expect(opts).toEqual({ ContentType: 'text/html' });
  });

  it('413s and skips storage when the body exceeds the per-file cap', async () => {
    mocks.verify.mockReturnValue({ draftId: 'd1', path: 'big.bin' });
    const { res, promise } = run({
      query: { token: 'good' },
      body: Buffer.alloc(PUBLISH_LIMITS.maxFileBytes + 1),
    });
    await promise;
    expect(res._getStatusCode()).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
