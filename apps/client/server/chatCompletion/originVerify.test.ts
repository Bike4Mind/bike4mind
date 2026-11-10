import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireOriginVerify } from './originVerify';

const SECRET = 'origin-secret-value';

const makeRequest = (headers: Request['headers']) =>
  ({ method: 'POST', path: '/api/ai/v1/completions', headers }) as unknown as Request;

const makeResponse = () => {
  const res = { status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};

describe('requireOriginVerify', () => {
  beforeEach(() => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('strips the header before calling the next handler', () => {
    const req = makeRequest({ 'x-b4m-origin-verify': SECRET, accept: '*/*' });
    const next: NextFunction = vi.fn();

    requireOriginVerify(req, makeResponse() as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers).not.toHaveProperty('x-b4m-origin-verify');
    expect(req.headers.accept).toBe('*/*');
  });

  it('refuses a repeated header and names the route in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = makeRequest({ 'x-b4m-origin-verify': [SECRET, SECRET] as unknown as string });
    const res = makeResponse();
    const next: NextFunction = vi.fn();

    requireOriginVerify(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('POST /api/ai/v1/completions'));
  });

  it('redacts a share-link token in the refusal log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = 'synthetic-share-token-0123456789';
    const req = { method: 'GET', path: `/api/publish/serve/a/${token}/index.html`, headers: {} } as unknown as Request;

    requireOriginVerify(req, makeResponse() as unknown as Response, vi.fn());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GET /api/publish/serve/a/[redacted]/index.html'));
    expect(String(warn.mock.calls)).not.toContain(token);
  });
});
