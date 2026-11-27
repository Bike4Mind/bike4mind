import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import committedSpec from '@public/openapi.json';

import { diffOpenApiDocument, type OpenApiPatchNode } from '@bike4mind/common';
import { createOpenApiSpecHandler } from '@server/utils/openApiSpecHandler';

const generated = vi.hoisted(() => ({ patch: null as OpenApiPatchNode | null }));

vi.mock('@server/premium-generated/deploymentOpenApi.generated', () => ({
  get deploymentOpenApiPatch() {
    return generated.patch;
  },
}));

const PLACEHOLDER = committedSpec.servers[0].url;

// The full deployment document the generator would produce: core plus one add-on operation.
const deploymentSpec = {
  ...committedSpec,
  paths: {
    ...committedSpec.paths,
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

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function fetchSpec(handler: Handler, headers: Record<string, string>) {
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
  return { status, body };
}

const rawBody = (handler: Handler, headers: Record<string, string> = {}) => fetchSpec(handler, headers).body;

function get(handler: Handler, headers: Record<string, string> = {}) {
  const { status, body } = fetchSpec(handler, headers);
  return { status, json: JSON.parse(body) as { paths: Record<string, unknown>; servers: { url: string }[] } };
}

describe('GET /api/v1/openapi.deployment.json', () => {
  beforeEach(() => {
    generated.patch = null;
  });

  it('serves the committed core spec when no add-on contracts were generated', async () => {
    const { status, json } = get(await loadHandler());
    expect(status).toBe(200);
    expect(Object.keys(json.paths)).toEqual(Object.keys(committedSpec.paths));
  });

  it('serves the core spec plus the add-on operations when a patch was generated', async () => {
    generated.patch = diffOpenApiDocument(committedSpec, deploymentSpec);
    const { json } = get(await loadHandler());
    expect(Object.keys(json.paths)).toEqual(Object.keys(deploymentSpec.paths));
  });

  it('serves the same bytes as the full deployment document would', async () => {
    generated.patch = diffOpenApiDocument(committedSpec, deploymentSpec);
    const headers = { host: 'api.acme.test', 'x-forwarded-proto': 'https' };
    expect(rawBody(await loadHandler(), headers)).toBe(rawBody(createOpenApiSpecHandler(deploymentSpec), headers));
  });

  it('points the generated spec at the request origin, like the core spec route', async () => {
    generated.patch = diffOpenApiDocument(committedSpec, deploymentSpec);
    const { json } = get(await loadHandler(), { host: 'api.acme.test', 'x-forwarded-proto': 'https' });
    expect(json.servers).toEqual([{ url: 'https://api.acme.test', description: 'Current deployment' }]);
    expect(JSON.stringify(json.paths)).toContain('curl https://api.acme.test/api/v1/widgets');
    expect(JSON.stringify(json)).not.toContain(PLACEHOLDER);
  });
});
