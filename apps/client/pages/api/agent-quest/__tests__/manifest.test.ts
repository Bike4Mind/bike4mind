import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { AGENT_QUEST_MANIFEST } from '@bike4mind/common';
import handler from '../manifest';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getBody: () => string;
}

/** Mirrors makeRes in pages/api/v1/__tests__/openapi.json.test.ts. */
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

function makeReq(method: 'GET' | 'HEAD' | 'OPTIONS' | 'POST', headers: Record<string, string> = {}): NextApiRequest {
  return { method, headers } as unknown as NextApiRequest;
}

describe('GET /api/agent-quest/manifest', () => {
  it('returns 200 with the quest manifest as JSON', () => {
    const { res, getStatus, getBody, headers } = makeRes();

    handler(makeReq('GET'), res);

    expect(getStatus()).toBe(200);
    expect(headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(getBody())).toEqual(JSON.parse(JSON.stringify(AGENT_QUEST_MANIFEST)));
  });

  it('serves the agent-quest entry with its steps', () => {
    const { res, getBody } = makeRes();

    handler(makeReq('GET'), res);

    const manifest = JSON.parse(getBody()) as { id: string; steps: Array<{ id: string; status: string }> };
    expect(manifest.id).toBe('agent-quest');
    expect(manifest.steps[0]).toMatchObject({ id: 'read-the-manifest', status: 'available' });
  });

  // The whole point of the route: an agent has to be able to read the invitation
  // before it holds any credential, since the quest is how it earns one.
  it('needs no credential and does not vary by origin', () => {
    const anonymous = makeRes();
    const withHost = makeRes();

    handler(makeReq('GET'), anonymous.res);
    handler(makeReq('GET', { host: 'somewhere.example.test', 'x-forwarded-proto': 'http' }), withHost.res);

    expect(anonymous.getStatus()).toBe(200);
    expect(withHost.getBody()).toBe(anonymous.getBody());
    expect(anonymous.headers['Vary']).toBeUndefined();
  });

  it('sets fully permissive CORS so any agent or browser tool can fetch it', () => {
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
