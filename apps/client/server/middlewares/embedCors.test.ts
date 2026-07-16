import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { embedCors } from './embedCors';
import type { Request, Response } from 'express';

function run(method: string, headers: Record<string, string> = {}) {
  const { req, res } = createMocks({ method, headers });
  const next = vi.fn();
  embedCors()(req as unknown as Request, res as unknown as Response, next);
  return { req, res, next };
}

describe('embedCors', () => {
  it('echoes the request Origin with Vary and the allowed methods/headers', () => {
    const { res, next } = run('POST', { origin: 'https://example.com' });
    expect(res.getHeader('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(res.getHeader('Vary')).toBe('Origin');
    expect(res.getHeader('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(res.getHeader('Access-Control-Allow-Headers')).toContain('X-API-Key');
    expect(next).toHaveBeenCalledOnce();
  });

  it('answers an OPTIONS preflight with 204 and does not call next', () => {
    const { res, next } = run('OPTIONS', { origin: 'https://example.com' });
    expect(res._getStatusCode()).toBe(204);
    expect(res._isEndCalled()).toBe(true);
    expect(res.getHeader('Access-Control-Allow-Origin')).toBe('https://example.com');
    expect(next).not.toHaveBeenCalled();
  });

  it('sets no CORS headers and passes through when there is no Origin (server-to-server)', () => {
    const { res, next } = run('POST');
    expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
