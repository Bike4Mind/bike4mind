import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../widget';
import { EMBED_CHAT_PATH } from '@client/app/utils/embedSnippet';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getBody: () => string;
}

function makeRes(): Captured {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
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
  return { res, headers, getStatus: () => statusCode, getBody: () => body };
}

function makeReq(method: string): NextApiRequest {
  return { method, headers: {} } as unknown as NextApiRequest;
}

describe('GET /api/embed/widget - loader script', () => {
  it('serves cacheable first-party JavaScript', () => {
    const { res, headers, getStatus, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getStatus()).toBe(200);
    expect(headers['Content-Type']).toContain('application/javascript');
    expect(headers['Cache-Control']).toBe('public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(getBody()).toContain('(function');
    expect(getBody()).toContain("'use strict'");
  });

  it('reads config from its own script tag, not a mount node', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('document.currentScript');
    expect(body).toContain('data-key');
  });

  it('derives the app origin from the script src, never the embedding page', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('new URL(script.src).origin');
    expect(body).not.toContain('window.location.origin');
  });

  it('locks the iframe to the shared pretty-path contract', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getBody()).toContain(EMBED_CHAT_PATH);
    expect(getBody()).toContain("'?k=' + encodeURIComponent(key)");
  });

  it('builds DOM safely and fails soft without a key', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).not.toContain('innerHTML');
    expect(body).toContain('console.warn');
    expect(body).not.toContain('throw ');
  });

  it('guards against double inclusion', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getBody()).toContain('__b4mEmbedMounted');
  });

  it('rejects non-GET/HEAD methods with 405', () => {
    const { res, getStatus, headers } = makeRes();
    handler(makeReq('POST'), res);
    expect(getStatus()).toBe(405);
    expect(headers['Allow']).toBe('GET, HEAD');
  });
});
