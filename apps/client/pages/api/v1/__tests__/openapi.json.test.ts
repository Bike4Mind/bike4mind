import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../openapi.json';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getJson: () => unknown;
  getBody: () => string;
}

function makeRes(): Captured {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let json: unknown;
  let body = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      json = payload;
      return res;
    },
    send(payload: string) {
      body = payload ?? '';
      return res;
    },
    end(payload?: string) {
      if (payload !== undefined) body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  return {
    res,
    headers,
    getStatus: () => statusCode,
    getJson: () => json,
    getBody: () => body,
  };
}

function makeReq(method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST', headers: Record<string, string> = {}): NextApiRequest {
  return { method, headers } as unknown as NextApiRequest;
}

describe('GET /api/v1/openapi.json', () => {
  it('returns 200 with the OpenAPI 3.1 spec as JSON', () => {
    const { res, getStatus, getBody, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(getStatus()).toBe(200);
    expect(headers['Content-Type']).toContain('application/json');
    const spec = JSON.parse(getBody()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths?.['/api/ai/v1/completions']).toBeDefined();
  });

  it('rewrites the placeholder prod URL to the request origin in servers AND code samples', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET', { host: 'api.example.test', 'x-forwarded-proto': 'https' }), res);
    const body = getBody();
    // No committed placeholder host survives anywhere in the served contract.
    expect(body).not.toContain('your-deployment.example.com');
    const spec = JSON.parse(body) as {
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { 'x-codeSamples'?: Array<{ source: string }> }>>;
    };
    // Collapsed to the one real origin (placeholder staging/local dropped).
    expect(spec.servers).toHaveLength(1);
    expect(spec.servers[0].url).toBe('https://api.example.test');
    const curl = spec.paths['/api/ai/v1/completions'].post['x-codeSamples']?.find(s => s.source.startsWith('curl'));
    expect(curl?.source).toContain('https://api.example.test/api/ai/v1/completions');
  });

  it('honors x-forwarded-proto when building the origin', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET', { host: 'local.test:3000', 'x-forwarded-proto': 'http' }), res);
    const spec = JSON.parse(getBody()) as { servers: Array<{ url: string }> };
    expect(spec.servers[0].url).toBe('http://local.test:3000');
  });

  it('serves the committed spec unchanged when no Host header is present', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const spec = JSON.parse(getBody()) as { openapi?: string };
    expect(spec.openapi).toBe('3.1.0');
  });

  it('sets Vary so shared caches key on the rewritten host', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET', { host: 'api.example.test' }), res);
    expect(headers['Vary']).toContain('Host');
  });

  it('sets fully permissive CORS so any origin/tool can fetch the contract', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toContain('GET');
  });

  it('sets nosniff and a cache header', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toContain('max-age');
  });

  it('answers OPTIONS preflight with 204 + CORS headers', () => {
    const { res, getStatus, headers } = makeRes();
    handler(makeReq('OPTIONS'), res);
    expect(getStatus()).toBe(204);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Max-Age']).toBe('600');
  });

  it('responds to HEAD with headers but no body', () => {
    const { res, getStatus, getBody, headers } = makeRes();
    handler(makeReq('HEAD'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toBe('');
    expect(headers['Content-Type']).toContain('application/json');
  });

  it('rejects non-GET/HEAD methods with 405', () => {
    const { res, getStatus, headers } = makeRes();
    handler(makeReq('POST'), res);
    expect(getStatus()).toBe(405);
    expect(headers['Allow']).toContain('GET');
  });
});
