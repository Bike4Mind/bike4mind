import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import committedSpec from '@public/openapi.json';

const generated = vi.hoisted(() => ({ spec: null as Record<string, unknown> | null }));

vi.mock('@server/premium-generated/deploymentOpenApi.generated', () => ({
  get deploymentOpenApiSpec() {
    return generated.spec;
  },
}));

const PLACEHOLDER = 'https://your-deployment.example.com';

const addOnSpec = {
  openapi: '3.1.0',
  servers: [{ url: PLACEHOLDER }],
  paths: {
    '/api/v1/widgets': {
      get: { operationId: 'listWidgets', 'x-codeSamples': [{ source: `curl ${PLACEHOLDER}/api/v1/widgets` }] },
    },
  },
};

// The handler captures its document at module load, so each case imports a fresh copy.
async function loadHandler() {
  vi.resetModules();
  return (await import('../openapi.deployment.json')).default;
}

function get(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, headers: Record<string, string> = {}) {
  let status = 200;
  let body = '';
  const res = {
    setHeader: () => res,
    status(code: number) {
      status = code;
      return res;
    },
    send(payload: string) {
      body = payload;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET', headers } as unknown as NextApiRequest, res);
  return { status, json: JSON.parse(body) as { paths: Record<string, unknown>; servers: { url: string }[] } };
}

describe('GET /api/v1/openapi.deployment.json', () => {
  beforeEach(() => {
    generated.spec = null;
  });

  it('serves the committed core spec when no add-on contracts were generated', async () => {
    const { status, json } = get(await loadHandler());
    expect(status).toBe(200);
    expect(Object.keys(json.paths)).toEqual(Object.keys(committedSpec.paths));
  });

  it('serves the generated deployment spec when there is one', async () => {
    generated.spec = addOnSpec;
    const { json } = get(await loadHandler());
    expect(Object.keys(json.paths)).toEqual(['/api/v1/widgets']);
  });

  it('points the generated spec at the request origin, like the core spec route', async () => {
    generated.spec = addOnSpec;
    const { json } = get(await loadHandler(), { host: 'api.acme.test', 'x-forwarded-proto': 'https' });
    expect(json.servers).toEqual([{ url: 'https://api.acme.test', description: 'Current deployment' }]);
    expect(JSON.stringify(json.paths)).toContain('curl https://api.acme.test/api/v1/widgets');
    expect(JSON.stringify(json)).not.toContain(PLACEHOLDER);
  });
});
