// @vitest-environment node
/**
 * The callable function routes through the real `baseApi` chain and error handler, with the session check, the
 * setting, and the registry stubbed. The registry's own rules run against a real mongod in
 * packages/server-utils/src/callableFunctions/registry.e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  BadRequestError,
  CallableFunctionBreakingChangeError,
  CallableFunctionSlugConflictError,
  ConflictError,
  NotFoundError,
  type FunctionContractChange,
} from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  noUser: false,
  perUserBuckets: [] as string[],
  validateApiKey: vi.fn(),
  registry: {
    createCallableFunction: vi.fn(),
    listCallableFunctions: vi.fn(),
    getCallableFunction: vi.fn(),
    repinCallableFunction: vi.fn(),
    setCallableFunctionEnabled: vi.fn(),
    setCallableFunctionApproval: vi.fn(),
    deleteCallableFunction: vi.fn(),
  },
}));

vi.mock('@bike4mind/server-utils/callableFunctions/registry', () => ({
  ...h.registry,
  updateCallableFunctionSettings: (
    actor: { id: string },
    id: string,
    settings: { enabled: boolean } | { approval: string }
  ) =>
    'approval' in settings
      ? h.registry.setCallableFunctionApproval(actor, id, settings.approval)
      : h.registry.setCallableFunctionEnabled(actor, id, settings.enabled),
}));
vi.mock('@bike4mind/server-utils/callableFunctions/access', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    resolveCallableFunctionsEnabled: vi.fn(async () => h.enabled),
    assertCallableFunctionsEnabled: vi.fn(async () => {
      if (!h.enabled) throw new ForbiddenError('Callable functions are disabled');
    }),
  };
});
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (bucket: string) => {
    h.perUserBuckets.push(bucket);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...args: unknown[]) => h.validateApiKey(...args),
    },
  };
});
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (
      req: { headers?: Record<string, unknown>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user && !h.noUser) req.user = JWT_USER;
      next();
    },
  };
});

import listRoute from '../index';
import itemRoute from '../[id]/index';
import pinRoute from '../[id]/pin';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const CONTRACT = { name: 'beam_midspan_deflection', description: 'Midspan deflection.' };
const CREATE_BODY = { artifactId: 'artifact-1', expectedVersion: 3, contract: CONTRACT };
const PIN_BODY = { expectedVersion: 4, contract: CONTRACT };
const VIEW = { id: FUNCTION_ID, slug: 'beam_midspan_deflection', status: 'draft' };

interface Call {
  name: string;
  handler: Handler;
  method: RequestMethod;
  query?: Record<string, unknown>;
  body?: unknown;
}

const LIST: Call = { name: 'GET list', handler: listRoute as Handler, method: 'GET' };
const CREATE: Call = { name: 'POST create', handler: listRoute as Handler, method: 'POST', body: CREATE_BODY };
const GET: Call = { name: 'GET item', handler: itemRoute as Handler, method: 'GET', query: { id: FUNCTION_ID } };
const PATCH: Call = {
  name: 'PATCH item',
  handler: itemRoute as Handler,
  method: 'PATCH',
  query: { id: FUNCTION_ID },
  body: { enabled: false },
};
const DELETE: Call = {
  name: 'DELETE item',
  handler: itemRoute as Handler,
  method: 'DELETE',
  query: { id: FUNCTION_ID },
};
const PIN: Call = {
  name: 'POST pin',
  handler: pinRoute as Handler,
  method: 'POST',
  query: { id: FUNCTION_ID },
  body: PIN_BODY,
};
const ALL = [LIST, CREATE, GET, PATCH, DELETE, PIN];

async function fire(call: Call, headers: Record<string, string> = { authorization: 'Bearer live-jwt' }) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: call.method,
      url: '/api/callable-functions',
      query: call.query ?? {},
      body: call.body as never,
      headers: { 'content-type': 'application/json', ...headers },
    },
    { eventEmitter: EventEmitter }
  );
  await call.handler(req, res);
  return res;
}

const registryCalls = () => Object.values(h.registry).reduce((sum, fn) => sum + fn.mock.calls.length, 0);

beforeEach(() => {
  h.enabled = true;
  h.noUser = false;
  h.validateApiKey.mockReset();
  for (const fn of Object.values(h.registry)) fn.mockReset();
  h.registry.listCallableFunctions.mockResolvedValue([VIEW]);
  h.registry.createCallableFunction.mockResolvedValue(VIEW);
  h.registry.getCallableFunction.mockResolvedValue({ ...VIEW, contract: CONTRACT, source: 'def run(): ...' });
  h.registry.setCallableFunctionEnabled.mockResolvedValue({ ...VIEW, enabled: false, status: 'disabled' });
  h.registry.setCallableFunctionApproval.mockResolvedValue({ ...VIEW, approval: 'always_ask' });
  h.registry.repinCallableFunction.mockResolvedValue(VIEW);
  h.registry.deleteCallableFunction.mockResolvedValue(undefined);
});

describe('session', () => {
  it.each(ALL.map(call => [call.name, call] as const))('%s answers 401 without a session', async (_name, call) => {
    const res = await fire(call, {});
    expect(res._getStatusCode()).toBe(401);
    expect(registryCalls()).toBe(0);
  });

  it.each(ALL.map(call => [call.name, call] as const))(
    '%s refuses an API key without looking it up',
    async (_name, call) => {
      const res = await fire(call, { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' });
      expect(res._getStatusCode()).toBe(401);
      expect(h.validateApiKey).not.toHaveBeenCalled();
      expect(registryCalls()).toBe(0);
    }
  );

  it.each(ALL.map(call => [call.name, call] as const))(
    '%s answers 401 and calls no registry function when the session has no user',
    async (_name, call) => {
      h.noUser = true;
      const res = await fire(call);
      expect(res._getStatusCode()).toBe(401);
      expect(res._getJSONData()).toMatchObject({ error: 'Sign in to use callable functions.' });
      expect(registryCalls()).toBe(0);
    }
  );

  it('uses one per-user rate limit bucket per method and route', () => {
    expect([...h.perUserBuckets].sort()).toEqual(
      [
        'GET /api/callable-functions',
        'POST /api/callable-functions',
        'GET /api/callable-functions/[id]',
        'PATCH /api/callable-functions/[id]',
        'DELETE /api/callable-functions/[id]',
        'POST /api/callable-functions/[id]/pin',
      ].sort()
    );
  });
});

describe('with the setting off', () => {
  beforeEach(() => {
    h.enabled = false;
  });

  it('the list answers [] without reading the registry', async () => {
    const res = await fire(LIST);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual([]);
    expect(h.registry.listCallableFunctions).not.toHaveBeenCalled();
  });

  it.each([CREATE, GET, PATCH, PIN].map(call => [call.name, call] as const))(
    '%s answers 403 and writes nothing',
    async (_name, call) => {
      const res = await fire(call);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData()).toMatchObject({ error: 'Callable functions are disabled' });
      expect(registryCalls()).toBe(0);
    }
  );

  it('the create answers 403 before reading the body', async () => {
    const res = await fire({ ...CREATE, body: { ...CREATE_BODY, codeHash: 'f'.repeat(64) } });
    expect(res._getStatusCode()).toBe(403);
    expect(h.registry.createCallableFunction).not.toHaveBeenCalled();
  });

  it('delete still works', async () => {
    const res = await fire(DELETE);
    expect(res._getStatusCode()).toBe(204);
    expect(h.registry.deleteCallableFunction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID
    );
  });
});

describe('request bodies', () => {
  const SERVER_SET = [
    ['codeHash', 'f'.repeat(64)],
    ['contentHash', 'f'.repeat(64)],
    ['pin', { version: 1 }],
    ['slug', 'chosen_name'],
    ['description', 'Chosen description.'],
    ['state', 'live'],
    ['enabled', true],
    ['trustLabel', 'verified'],
    ['label', 'verified'],
    ['runtime', 'server'],
    ['userId', 'someone-else'],
    ['ownerKey', 'someone-else'],
  ] as const;

  it.each(SERVER_SET)('create refuses a body naming %s', async (key, value) => {
    const res = await fire({ ...CREATE, body: { ...CREATE_BODY, [key]: value } });
    expect(res._getStatusCode()).toBe(400);
    const body = res._getJSONData();
    expect(body.code).toBe('invalid_body');
    expect(JSON.stringify(body.issues)).toContain(key);
    expect(h.registry.createCallableFunction).not.toHaveBeenCalled();
  });

  it.each(SERVER_SET)('pin refuses a body naming %s', async (key, value) => {
    const res = await fire({ ...PIN, body: { ...PIN_BODY, [key]: value } });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.registry.repinCallableFunction).not.toHaveBeenCalled();
  });

  // Not in SERVER_SET because create takes it: a pin naming it could move the tool to another artifact.
  it('pin refuses a body naming artifactId', async () => {
    const res = await fire({ ...PIN, body: { ...PIN_BODY, artifactId: 'another-artifact' } });
    expect(res._getStatusCode()).toBe(400);
    const body = res._getJSONData();
    expect(body.code).toBe('invalid_body');
    expect(JSON.stringify(body.issues)).toContain('artifactId');
    expect(h.registry.repinCallableFunction).not.toHaveBeenCalled();
  });

  it.each([
    ['a version below 1', { expectedVersion: 0 }],
    ['a fractional version', { expectedVersion: 1.5 }],
    ['a version sent as text', { expectedVersion: '3' }],
    ['a contract that is a list', { contract: [CONTRACT] }],
    ['a contract that is text', { contract: 'FUNCTION = {}' }],
    ['no contract', { contract: undefined }],
    ['a blank artifact id', { artifactId: '   ' }],
    ['an artifact id over 200 characters', { artifactId: 'a'.repeat(201) }],
  ])('create refuses %s', async (_name, patch) => {
    const res = await fire({ ...CREATE, body: { ...CREATE_BODY, ...patch } });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.registry.createCallableFunction).not.toHaveBeenCalled();
  });

  it('patch takes enabled or approval, one at a time', async () => {
    for (const body of [
      {},
      { enabled: 'no' },
      { enabled: true, slug: 'x' },
      { approval: 'sometimes' },
      { enabled: true, approval: 'always_ask' },
    ]) {
      const res = await fire({ ...PATCH, body });
      expect(res._getStatusCode()).toBe(400);
    }
    expect(h.registry.setCallableFunctionEnabled).not.toHaveBeenCalled();
    expect(h.registry.setCallableFunctionApproval).not.toHaveBeenCalled();
  });

  it('patch with approval sets it and leaves enabled alone', async () => {
    const res = await fire({ ...PATCH, body: { approval: 'always_ask' } });
    expect(res._getStatusCode()).toBe(200);
    expect(h.registry.setCallableFunctionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID,
      'always_ask'
    );
    expect(h.registry.setCallableFunctionEnabled).not.toHaveBeenCalled();
  });
});

describe('forwarding to the registry', () => {
  it('create passes the session user and only the three body fields, and answers 201', async () => {
    const res = await fire({ ...CREATE, body: { ...CREATE_BODY, artifactId: '  artifact-1  ' } });
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual(VIEW);
    const [actor, input] = h.registry.createCallableFunction.mock.calls[0]!;
    expect(actor).toMatchObject({ id: 'jwt-user' });
    expect(input).toEqual(CREATE_BODY);
  });

  it('the list passes a single artifactId filter and ignores a repeated one', async () => {
    await fire({ ...LIST, query: { artifactId: 'artifact-1' } });
    await fire({ ...LIST, query: { artifactId: ['a', 'b'] } });
    expect(h.registry.listCallableFunctions.mock.calls.map(([, filter]) => filter)).toEqual([
      { artifactId: 'artifact-1' },
      { artifactId: undefined },
    ]);
  });

  it('item routes pass the id from the path', async () => {
    expect((await fire(GET))._getStatusCode()).toBe(200);
    expect((await fire(PATCH))._getJSONData()).toMatchObject({ status: 'disabled' });
    expect((await fire(PIN))._getStatusCode()).toBe(200);
    expect(h.registry.getCallableFunction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID
    );
    expect(h.registry.setCallableFunctionEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID,
      false
    );
    expect(h.registry.repinCallableFunction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID,
      PIN_BODY
    );
  });

  it('a repeated id reaches the registry as an empty id, which it answers 404', async () => {
    h.registry.getCallableFunction.mockRejectedValue(new NotFoundError('Tool not found'));
    const res = await fire({ ...GET, query: { id: [FUNCTION_ID, FUNCTION_ID] } });
    expect(h.registry.getCallableFunction).toHaveBeenCalledWith(expect.anything(), '');
    expect(res._getStatusCode()).toBe(404);
  });

  it('keeps the error envelope and its code for registry refusals', async () => {
    h.registry.getCallableFunction.mockRejectedValue(new NotFoundError('Tool not found'));
    const missing = await fire(GET);
    expect(missing._getStatusCode()).toBe(404);
    expect(missing._getJSONData()).toMatchObject({ error: 'Tool not found' });

    h.registry.repinCallableFunction.mockRejectedValue(
      new ConflictError('The artifact changed since you opened it. Reload it and try again.', {
        code: 'version_changed',
        version: 5,
      })
    );
    const stale = await fire(PIN);
    expect(stale._getStatusCode()).toBe(409);
    expect(stale._getJSONData()).toMatchObject({ code: 'version_changed', version: 5 });

    const problems = [{ path: 'inputs.properties.x.unit', message: 'is required' }];
    h.registry.createCallableFunction.mockRejectedValue(
      new BadRequestError('The function contract has problems.', { code: 'invalid_contract', problems })
    );
    const invalid = await fire(CREATE);
    expect(invalid._getStatusCode()).toBe(400);
    expect(invalid._getJSONData()).toMatchObject({ code: 'invalid_contract', problems });

    h.registry.createCallableFunction.mockRejectedValue(
      new CallableFunctionSlugConflictError('beam_midspan_deflection', { functionId: FUNCTION_ID, sourceDeleted: true })
    );
    const taken = await fire(CREATE);
    expect(taken._getStatusCode()).toBe(409);
    expect(taken._getJSONData()).toMatchObject({
      error: 'You already have a tool named beam_midspan_deflection.',
      code: 'slug_taken',
      slug: 'beam_midspan_deflection',
      functionId: FUNCTION_ID,
      sourceDeleted: true,
    });
  });

  it('answers a breaking repin with 409 breaking_change and each change', async () => {
    const changes: FunctionContractChange[] = [
      { path: 'inputs.load.unit', side: 'inputs', field: 'load', kind: 'unit_changed', before: 'N', after: 'kN' },
      { path: 'outputs.deflection', side: 'outputs', field: 'deflection', kind: 'removed' },
    ];
    h.registry.repinCallableFunction.mockRejectedValue(new CallableFunctionBreakingChangeError(changes));
    const refused = await fire(PIN);
    expect(refused._getStatusCode()).toBe(409);
    expect(refused._getJSONData()).toMatchObject({
      error:
        'Input load changed unit from N to kN; output deflection was removed, which could break callers of the tool, ' +
        'so it stays on its current version. To keep it as it is and save this version as a new tool, give the ' +
        'function a new name in FUNCTION, save the artifact, and select Make this a tool.',
      code: 'breaking_change',
      changes,
    });
  });

  it('refuses a repin body that asks to accept a breaking change', async () => {
    const res = await fire({ ...PIN, body: { ...PIN_BODY, acceptBreaking: true } });
    expect(res._getStatusCode()).toBe(400);
    expect(h.registry.repinCallableFunction).not.toHaveBeenCalled();
  });
});
