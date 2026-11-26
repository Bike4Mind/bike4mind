// @vitest-environment node
/**
 * Route tests for the public functions API under /api/v1/functions. `baseApi`, the database, the setting, and the
 * runtime are stubbed; the contract prelude, the registry, the dispatcher, and the input and output checks run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  getFunctionCallContract,
  getFunctionContract,
  invokeFunctionContract,
  isZodError,
  listFunctionsContract,
  reviewHash,
  type FunctionContract,
} from '@bike4mind/common';
import { decideScopeGate } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import type {
  CallableFunctionRunPayload,
  CallableFunctionRunResult,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

const h = vi.hoisted(() => ({
  rateLimitOptions: [] as Array<{ bucket?: string }>,
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
  realLimiter: { value: false },
  perMin: { value: 60 },
  buckets: new Map<string, number>(),
  enabled: { value: true },
  functions: [] as Record<string, unknown>[],
  artifacts: [] as { id: string; userId: string; version: number; deletedAt: Date | null }[],
  calls: [] as Record<string, unknown>[],
  recordFails: { value: false },
  reviews: [] as Record<string, unknown>[],
  runner: vi.fn(),
  runnerConfigured: { value: true },
  limitMs: { value: 30_000 },
  pendingLimit: { value: 10 },
  results: new Map<string, Record<string, unknown>>(),
  sent: [] as { url: string; message: Record<string, unknown> }[],
  sendFails: { value: false },
}));

vi.mock('@bike4mind/server-utils/callableFunctions/timeLimit', () => ({
  resolveCallableFunctionTimeLimitMs: async () => h.limitMs.value,
  resolveCallableFunctionPendingCallLimit: async () => h.pendingLimit.value,
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (name: string) => `queue://${name}`,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendToQueue: async (url: string, message: Record<string, unknown>) => {
    if (h.sendFails.value) throw new Error('queue down');
    h.sent.push({ url, message });
    return 'message-1';
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    h.baseApiOptions.push(options);
    type Mw = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          let failure: unknown;
          await handler(req, res, (error?: unknown) => {
            advanced = true;
            failure = error;
          });
          if (failure) throw failure;
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    for (const verb of ['get', 'post', 'patch', 'delete', 'put']) chain[verb] = compose;
    return chain;
  },
}));
// The real limiter runs over an in-memory counter when `realLimiter` is on; otherwise requests pass.
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/middlewares/rateLimit')>();
  type Middleware = ReturnType<typeof actual.rateLimit>;
  return {
    rateLimit: (options: Parameters<typeof actual.rateLimit>[0]) => {
      h.rateLimitOptions.push(options);
      const real = actual.rateLimit(options);
      return (...args: Parameters<Middleware>) => {
        if (h.realLimiter.value) return real(...args);
        args[2]();
      };
    },
  };
});
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => h.perMin.value }));
vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: async () => h.enabled.value,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/runtimeRunner', () => ({
  selectCallableFunctionRunner: () => (h.runnerConfigured.value ? h.runner : null),
}));

type Owner = { ownerType: string; ownerKey: string };
const owned = (owner: Owner) => (fn: Record<string, unknown>) => fn.ownerKey === owner.ownerKey;
const isHexId = (id: string) => /^[0-9a-f]{24}$/.test(id);

vi.mock('@bike4mind/database', async () => ({
  mongoose: (await import('mongoose')).default,
  adminSettingsRepository: {},
  artifactContentRepository: {},
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: async (key: string, limit: number, windowMs: number) => {
      const count = (h.buckets.get(key) ?? 0) + 1;
      const expiresAt = new Date(Date.now() + windowMs);
      if (count > limit) return { success: false, expiresAt };
      h.buckets.set(key, count);
      return { success: true, expiresAt };
    },
  },
  callableFunctionRepository: {
    findById: async (id: string) => h.functions.find(fn => fn.id === id) ?? null,
    findByIdForOwner: async (id: string, owner: Owner) =>
      isHexId(id) ? (h.functions.find(fn => fn.id === id && owned(owner)(fn)) ?? null) : null,
    listForOwner: async (owner: Owner) => h.functions.filter(owned(owner)),
    listLiveForOwner: async (owner: Owner) =>
      h.functions.filter(fn => owned(owner)(fn) && fn.state === 'live' && fn.enabled),
    listSharedWith: async ({ userId }: { userId: string }) =>
      h.functions.filter(
        fn =>
          fn.ownerKey !== userId &&
          fn.enabled &&
          fn.state === 'live' &&
          (fn.grants as { userIds: string[] } | undefined)?.userIds.includes(userId)
      ),
  },
  callableFunctionReviewRepository: {
    findFor: async (functionId: string, userId: string) =>
      h.reviews.find(r => r.functionId === functionId && r.userId === userId) ?? null,
    findForUser: async (userId: string, ids: string[]) =>
      h.reviews.filter(r => r.userId === userId && ids.includes(r.functionId as string)),
  },
  projectRepository: { find: async () => [] },
  organizationRepository: { findMembershipOrgIds: async () => [] },
  artifactRepository: {
    find: async (filter: { id: { $in: string[] }; userId: string }) =>
      h.artifacts.filter(a => filter.id.$in.includes(a.id) && a.userId === filter.userId),
    findOne: async (filter: { id: string; userId: string }) =>
      h.artifacts.find(a => a.id === filter.id && a.userId === filter.userId) ?? null,
  },
  callableFunctionCallRepository: {
    record: async (row: Record<string, unknown>) => {
      if (h.recordFails.value) throw new Error('db down');
      h.calls.push(row);
      // A 24-hex id, as Mongo would give, so the poll route reads it.
      return { ...row, id: `6c${String(h.calls.length).padStart(22, '0')}` };
    },
    rewrite: async (id: string, row: Record<string, unknown>) => {
      const index = Number(id.slice(2)) - 1;
      h.calls[index] = { ...h.calls[index], ...row };
      return { ...h.calls[index], id };
    },
  },
  callableFunctionResultRepository: {
    createQueued: async (row: Record<string, unknown>) => {
      h.results.set(row.callId as string, { ...row, state: 'queued', createdAt: new Date() });
      return row;
    },
    finish: async (callId: string, end: Record<string, unknown>) => {
      h.results.set(callId, { ...h.results.get(callId), ...end, state: 'finished' });
      return end.outcome;
    },
    countPending: async (callerUserId: string) =>
      [...h.results.values()].filter(
        doc => doc.callerUserId === callerUserId && (doc.state === 'queued' || doc.state === 'running')
      ).length,
    findForCaller: async (callId: string, callerUserId: string) => {
      const doc = h.results.get(callId);
      return doc && doc.callerUserId === callerUserId ? doc : null;
    },
  },
}));

const { default: listRoute } = await import('@pages/api/v1/functions/index');
const { default: getRoute } = await import('@pages/api/v1/functions/[id]/index');
const { default: invokeRoute, config: invokeConfig } = await import('@pages/api/v1/functions/[id]/invoke');
const { default: pollRoute } = await import('@pages/api/v1/functions/calls/[call_id]');
const { queueFunctionCall } = await import('@bike4mind/server-utils/callableFunctions/asyncCalls');
const {
  FUNCTION_INVOKE_BUDGET_MS,
  FUNCTION_CALL_STOPPED_MESSAGE,
  FUNCTION_INVOKE_MAX_BODY_BYTES,
  FUNCTION_REVIEW_REQUIRED_MESSAGE,
  FUNCTION_SYNC_STOP_MESSAGE,
  FUNCTION_SYNC_STOP_SELF_HOST_MESSAGE,
  TIMEOUT_MESSAGE,
  functionCallAnswer,
  invokeAnswer,
} = await import('@server/callableFunctions/publicFunctions');
// The limiters are built once, at module load, before any beforeEach clears the recorder.
const rateLimitBuckets = h.rateLimitOptions.map(o => o.bucket);

const CONTRACT: FunctionContract = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    properties: {
      load: { type: 'number', unit: 'N/m', description: 'Uniform load.' },
      span: { type: 'number', unit: 'm', exclusiveMinimum: 0 },
    },
    required: ['load', 'span'],
    additionalProperties: false,
  },
  outputs: {
    type: 'object',
    properties: { deflection: { type: 'number', unit: 'm' } },
    required: ['deflection'],
    additionalProperties: false,
  },
  tests: [{ name: 'short span', input: { load: 1, span: 1 }, expected: { deflection: 1 } }],
};

const T0 = new Date('2026-11-20T10:00:00.000Z');
const LIVE_ID = '6b0000000000000000000001';
const DRAFT_ID = '6b0000000000000000000002';
const OTHERS_ID = '6b0000000000000000000003';
const MISSING_ID = '6b0000000000000000000009';

const fnDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ownerType: 'user',
  ownerKey: 'u1',
  userId: 'u1',
  slug: 'beam_midspan_deflection',
  description: CONTRACT.description,
  state: 'live',
  enabled: true,
  pin: {
    artifactId: `artifact-${id}`,
    version: 5,
    contentHash: 'c'.repeat(64),
    source: 'FUNCTION = {}\ndef run(load, span):\n    return {}\n',
    pinnedAt: T0,
    seq: 2,
  },
  contract: CONTRACT,
  trustLabel: 'verified',
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const okRun = (outputs: Record<string, unknown> = { deflection: 0.0081 }): CallableFunctionRunResult => ({
  outcome: 'ok',
  outputs,
  durationMs: 12,
  runtime: { lockHash: 'l'.repeat(64), packages: [{ name: 'numpy', version: '1.26.1' }] },
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

interface CallOptions {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  user?: string;
  keyId?: string;
}

type AnyHandler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(handler: unknown, { method = 'GET', query = {}, body, user = 'u1', keyId = 'k1' }: CallOptions) {
  const { req, res } = createMocks({ method: method as 'GET', query, body: body as object });
  Object.assign(req, { user: { id: user }, logger, headers: {}, apiKeyInfo: { keyId } });
  try {
    await (handler as AnyHandler)(req, res);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? (isZodError(error) ? 422 : 500);
    return { status, body: { error: (error as Error).message } as Record<string, unknown> };
  }
  const text = res._getData();
  return {
    status: res._getStatusCode(),
    body: (typeof text === 'string' && text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const invoke = (id: string, body: unknown, as: Pick<CallOptions, 'user' | 'keyId'> = {}) =>
  call(invokeRoute, { method: 'POST', query: { id }, body, ...as });

beforeEach(() => {
  vi.clearAllMocks();
  h.realLimiter.value = false;
  h.perMin.value = 60;
  h.buckets.clear();
  h.enabled.value = true;
  h.runnerConfigured.value = true;
  h.limitMs.value = 30_000;
  h.pendingLimit.value = 10;
  h.results = new Map();
  h.sent = [];
  h.sendFails.value = false;
  h.calls = [];
  h.recordFails.value = false;
  h.reviews = [];
  h.functions = [
    fnDoc(LIVE_ID),
    fnDoc(DRAFT_ID, { slug: 'beam_draft', state: 'draft', trustLabel: undefined }),
    fnDoc(OTHERS_ID, { slug: 'beam_other', ownerKey: 'u2', userId: 'u2' }),
  ];
  h.artifacts = h.functions.map(fn => ({
    id: (fn.pin as { artifactId: string }).artifactId,
    userId: fn.userId as string,
    version: 5,
    deletedAt: null,
  }));
  h.runner.mockImplementation(async (_payload: CallableFunctionRunPayload) => okRun());
});

describe('scopes and limits', () => {
  const contracts = [
    ['listFunctions', listFunctionsContract],
    ['getFunction', getFunctionContract],
    ['invokeFunction', invokeFunctionContract],
    ['getFunctionCall', getFunctionCallContract],
  ] as const;

  it.each(contracts)('%s names functions:invoke and declares the 403 scope envelope', (_name, contract) => {
    expect(contract.scopes).toEqual([ApiKeyScope.FUNCTIONS_INVOKE]);
    expect(contract.emitsRateLimitHeaders).toBe(true);
    expect(Object.keys(contract.responses)).toContain('403');
  });

  it.each(contracts)('%s answers 403 to a key without the scope', (_name, contract) => {
    expect(decideScopeGate(contract.scopes, [ApiKeyScope.AI_CHAT], new Set())).toEqual({ outcome: 'deny' });
    expect(decideScopeGate(contract.scopes, [ApiKeyScope.FUNCTIONS_INVOKE], new Set())).toEqual({ outcome: 'allow' });
  });

  it('hands functions:invoke to the API-key chain for every route', () => {
    const required = h.baseApiOptions.map(o => o?.requiredScopes);
    expect(required).toEqual([
      [ApiKeyScope.FUNCTIONS_INVOKE],
      [ApiKeyScope.FUNCTIONS_INVOKE],
      [ApiKeyScope.FUNCTIONS_INVOKE],
      [ApiKeyScope.FUNCTIONS_INVOKE],
    ]);
  });

  it('takes a body as large as the input cap on invoke only', () => {
    const [list, get, post] = h.baseApiOptions;
    expect(list?.maxBodySize).toBeUndefined();
    expect(get?.maxBodySize).toBeUndefined();
    expect(post?.maxBodySize).toBe(FUNCTION_INVOKE_MAX_BODY_BYTES);
    expect(FUNCTION_INVOKE_MAX_BODY_BYTES).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('uses one stable per-user rate-limit bucket per route, with no id in it', () => {
    expect(rateLimitBuckets).toEqual([
      '/api/v1/functions',
      '/api/v1/functions/[id]',
      '/api/v1/functions/[id]/invoke',
      '/api/v1/functions/calls/[call_id]',
    ]);
  });

  it('answers 429 from the limiter before the function is read or run', async () => {
    h.realLimiter.value = true;
    h.perMin.value = 0;
    const res = await invoke(LIVE_ID, { input: { load: 1, span: 2 } });
    expect(res).toEqual({
      status: 429,
      body: { error: 'Requests to this endpoint are currently blocked for your account.' },
    });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('counts one bucket per user, so a second key of the same user cannot pass it', async () => {
    h.realLimiter.value = true;
    h.perMin.value = 2;
    const body = { input: { load: 1, span: 2 } };
    expect((await invoke(LIVE_ID, body, { keyId: 'k1' })).status).toBe(200);
    expect((await invoke(LIVE_ID, body, { keyId: 'k2' })).status).toBe(200);
    expect(await invoke(LIVE_ID, body, { keyId: 'k3' })).toEqual({
      status: 429,
      body: { error: 'Rate limit exceeded. Try again in 60 seconds.' },
    });
    expect(h.runner).toHaveBeenCalledTimes(2);
    expect((await invoke(OTHERS_ID, body, { user: 'u2', keyId: 'k4' })).status).toBe(200);
  });

  it.each([
    ['list', () => call(listRoute, {})],
    ['read', () => call(getRoute, { query: { id: LIVE_ID } })],
    ['invoke', () => invoke(LIVE_ID, { input: { load: 1, span: 2 } })],
  ])('answers 403 when callable functions are off: %s', async (_name, run) => {
    h.enabled.value = false;
    expect(await run()).toEqual({
      status: 403,
      body: { error: 'Callable functions are turned off for this account.' },
    });
    expect(h.runner).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it("lists only the owner's live functions, without the pinned code", async () => {
    const res = await call(listRoute, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: LIVE_ID,
          slug: 'beam_midspan_deflection',
          description: CONTRACT.description,
          trust_label: 'verified',
          pin_version: 5,
          pin_seq: 2,
          updated_at: T0.toISOString(),
        },
      ],
      next_cursor: null,
    });
  });

  it('leaves out a live function that is turned off or whose artifact was deleted', async () => {
    h.functions.push(fnDoc('6b0000000000000000000004', { slug: 'off', enabled: false }));
    h.functions.push(fnDoc('6b0000000000000000000005', { slug: 'gone' }));
    h.artifacts.push({ id: 'artifact-6b0000000000000000000004', userId: 'u1', version: 5, deletedAt: null });
    const res = await call(listRoute, {});
    expect((res.body.data as { id: string }[]).map(fn => fn.id)).toEqual([LIVE_ID]);
  });

  it('pages by id with an opaque cursor', async () => {
    h.functions.push(fnDoc('6b0000000000000000000006', { slug: 'beam_two' }));
    h.artifacts.push({ id: 'artifact-6b0000000000000000000006', userId: 'u1', version: 5, deletedAt: null });
    const first = await call(listRoute, { query: { limit: '1' } });
    expect((first.body.data as { id: string }[]).map(fn => fn.id)).toEqual([LIVE_ID]);
    const second = await call(listRoute, { query: { limit: '1', cursor: first.body.next_cursor as string } });
    expect((second.body.data as { id: string }[]).map(fn => fn.id)).toEqual(['6b0000000000000000000006']);
    expect(second.body.next_cursor).toBeNull();
  });
});

describe('read', () => {
  it('returns the contract as input_schema and output_schema from the rest projection, and no code', async () => {
    const res = await call(getRoute, { query: { id: LIVE_ID } });
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.input_schema).toEqual(CONTRACT.inputs);
    expect(data.output_schema).toEqual(CONTRACT.outputs);
    expect(JSON.stringify(res.body)).not.toContain('def run');
    expect(data).not.toHaveProperty('tests');
  });
});

describe('not found', () => {
  const missing = { status: 404, body: { error: 'Function not found' } };

  it.each([
    ['a draft', DRAFT_ID],
    ["another person's function", OTHERS_ID],
    ['a missing id', MISSING_ID],
    ['a malformed id', 'not-an-id'],
  ])('answers %s with the same 404 on read and invoke', async (_name, id) => {
    expect(await call(getRoute, { query: { id } })).toEqual(missing);
    expect(await invoke(id, { input: { load: 1, span: 2 } })).toEqual(missing);
    expect(h.runner).not.toHaveBeenCalled();
  });

  it('writes one refused row per invoke of a function the caller cannot see, without inputs or outputs', async () => {
    await invoke(OTHERS_ID, { input: { load: 1, span: 2 } });
    await invoke(DRAFT_ID, { input: { load: 1, span: 2 } });
    await invoke('not-an-id', { input: { load: 1, span: 2 } });
    expect(h.calls).toHaveLength(3);
    for (const row of h.calls) {
      expect(row).toMatchObject({ callerUserId: 'u1', surface: 'rest', apiKeyId: 'k1', outcome: 'refused' });
      expect(row).not.toHaveProperty('inputs');
      expect(row).not.toHaveProperty('outputs');
    }
    expect(h.calls.map(row => [row.functionId, row.reason, row.ownerUserId])).toEqual([
      ['unknown', 'not_found', undefined],
      [DRAFT_ID, 'not_live', 'u1'],
      ['unknown', 'not_found', undefined],
    ]);
  });

  it('still answers the 404 when the refusal row cannot be written', async () => {
    h.recordFails.value = true;
    const res = await invoke(DRAFT_ID, { input: { load: 1, span: 2 } });
    expect(res).toEqual({ status: 404, body: { error: 'Function not found' } });
    expect(logger.warn).toHaveBeenCalledWith('[functions] refusal row not written', { message: 'db down' });
  });

  it('writes no row for a read of a function the caller cannot see', async () => {
    await call(getRoute, { query: { id: OTHERS_ID } });
    expect(h.calls).toHaveLength(0);
  });

  it('answers a turned-off function and one whose artifact was deleted with the same 404 on read and invoke', async () => {
    h.functions[0] = fnDoc(LIVE_ID, { enabled: false });
    expect(await call(getRoute, { query: { id: LIVE_ID } })).toEqual(missing);
    expect(await invoke(LIVE_ID, { input: { load: 1, span: 2 } })).toEqual(missing);
    h.functions[0] = fnDoc(LIVE_ID);
    h.artifacts = h.artifacts.filter(a => a.id !== `artifact-${LIVE_ID}`);
    expect(await call(getRoute, { query: { id: LIVE_ID } })).toEqual(missing);
    expect(await invoke(LIVE_ID, { input: { load: 1, span: 2 } })).toEqual(missing);
    expect(h.runner).not.toHaveBeenCalled();
  });
});

describe('a function shared with the caller', () => {
  const RECIPIENT = 'u3';
  const shareWithRecipient = () => {
    h.functions[2] = fnDoc(OTHERS_ID, {
      slug: 'beam_other',
      ownerKey: 'u2',
      userId: 'u2',
      grants: { visibility: 'private', userIds: [RECIPIENT] },
    });
  };
  const review = async () =>
    h.reviews.push({
      functionId: OTHERS_ID,
      userId: RECIPIENT,
      reviewHash: await reviewHash(CONTRACT),
      approval: 'default',
      enabled: true,
    });
  const as = { user: RECIPIENT, keyId: 'k3' };

  it('is refused before review, listed and run as the recipient after it, and gone once revoked', async () => {
    shareWithRecipient();
    expect((await call(listRoute, { user: RECIPIENT })).body.data).toEqual([]);
    expect(await call(getRoute, { query: { id: OTHERS_ID }, user: RECIPIENT })).toMatchObject({ status: 404 });
    const before = await invoke(OTHERS_ID, { input: { load: 1, span: 2 } }, as);
    expect(before).toEqual({ status: 403, body: { error: FUNCTION_REVIEW_REQUIRED_MESSAGE } });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.calls.at(-1)).toMatchObject({ callerUserId: RECIPIENT, ownerUserId: 'u2', reason: 'review_required' });

    await review();
    const list = await call(listRoute, { user: RECIPIENT });
    expect(list.body.data).toEqual([expect.objectContaining({ id: OTHERS_ID, slug: 'beam_other' })]);
    const read = await call(getRoute, { query: { id: OTHERS_ID }, user: RECIPIENT });
    expect((read.body.data as Record<string, unknown>).input_schema).toEqual(CONTRACT.inputs);
    expect(JSON.stringify(read.body)).not.toContain('def run');
    const after = await invoke(OTHERS_ID, { input: { load: 1, span: 2 } }, as);
    expect(after).toMatchObject({ status: 200, body: { output: { deflection: 0.0081 } } });
    expect(h.calls.at(-1)).toMatchObject({
      callerUserId: RECIPIENT,
      ownerUserId: 'u2',
      apiKeyId: 'k3',
      surface: 'rest',
      outcome: 'ok',
    });
    expect((await call(listRoute, {})).body.data).toEqual([expect.objectContaining({ id: LIVE_ID })]);

    h.functions[2] = fnDoc(OTHERS_ID, { slug: 'beam_other', ownerKey: 'u2', userId: 'u2' });
    expect((await call(listRoute, { user: RECIPIENT })).body.data).toEqual([]);
    expect(await invoke(OTHERS_ID, { input: { load: 1, span: 2 } }, as)).toEqual({
      status: 404,
      body: { error: 'Function not found' },
    });
    expect(h.runner).toHaveBeenCalledTimes(1);
  });
});

describe('invoke', () => {
  it('runs the live function on the rest surface and returns { output, stamp }', async () => {
    const res = await invoke(LIVE_ID, { input: { load: 2000, span: 4 } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['output', 'stamp']);
    expect(res.body.output).toEqual({ deflection: 0.0081 });
    expect(res.body.stamp).toMatchObject({
      function_id: LIVE_ID,
      slug: 'beam_midspan_deflection',
      pin_version: 5,
      pin_seq: 2,
      code_hash: 'c'.repeat(64),
      runtime: { kind: 'pyodide-server', lock_hash: 'l'.repeat(64) },
      packages: [{ name: 'numpy', version: '1.26.1' }],
      trust_label: 'verified',
      surface: 'rest',
    });
    expect((res.body.stamp as { input_hash: string }).input_hash).toMatch(/^[0-9a-f]{64}$/);

    const payload = h.runner.mock.calls[0][0] as CallableFunctionRunPayload & { limits: { timeoutMs: number } };
    expect(payload.limits.timeoutMs).toBe(30_000);
    expect(h.calls).toEqual([expect.objectContaining({ surface: 'rest', apiKeyId: 'k1', outcome: 'ok' })]);
  });

  it('answers 422 naming the field when an input does not fit, before anything runs', async () => {
    const res = await invoke(LIVE_ID, { input: { load: 2000, span: 'four' } });
    expect(res).toEqual({
      status: 422,
      body: { error: 'Input span must be a number.', problems: [{ path: 'span', message: 'must be a number' }] },
    });
    expect(h.runner).not.toHaveBeenCalled();
  });

  it('answers 422 naming a missing required input', async () => {
    const res = await invoke(LIVE_ID, { input: { load: 2000 } });
    expect(res).toEqual({
      status: 422,
      body: { error: 'Input span is required.', problems: [{ path: 'span', message: 'is required' }] },
    });
  });

  it('answers 422 for a body without input or with an unknown field', async () => {
    // The contract prelude throws here; baseApi's error handler (stubbed) writes the envelope.
    // The stub writes the thrown message, which is the JSON of the zod issues.
    const answer = async (body: unknown) => {
      const res = await invoke(LIVE_ID, body);
      return { status: res.status, body: { error: JSON.parse(String(res.body.error)) as unknown } };
    };
    expect(await answer({})).toEqual({
      status: 422,
      body: {
        error: [
          {
            expected: 'record',
            code: 'invalid_type',
            path: ['input'],
            message: 'Invalid input: expected record, received undefined',
          },
        ],
      },
    });
    expect(await answer({ input: { load: 1, span: 1 }, extra: true })).toEqual({
      status: 422,
      body: {
        error: [{ code: 'unrecognized_keys', keys: ['extra'], path: [], message: 'Unrecognized key: "extra"' }],
      },
    });
    expect(h.runner).not.toHaveBeenCalled();
  });

  const stamp = expect.objectContaining({ function_id: LIVE_ID, surface: 'rest' });

  it.each([
    [
      'error',
      { outcome: 'error', errorClass: 'ZeroDivisionError', durationMs: 3 },
      'The function raised an error (ZeroDivisionError).',
    ],
    ['memory', { outcome: 'memory', durationMs: 3 }, 'The function ran out of memory.'],
    [
      'output_invalid',
      { outcome: 'ok', outputs: { deflection: 'x' }, durationMs: 3 },
      'The function returned outputs that do not fit its output schema. Output deflection must be a number.',
    ],
    [
      'output_invalid',
      {
        outcome: 'output_invalid',
        problems: [{ path: 'report', message: 'must be at most 2000 characters (it has 4000000)' }],
        durationMs: 3,
      },
      'The function returned outputs that do not fit its output schema. Output report must be at most 2000 characters (it has 4000000).',
    ],
  ] as const)('answers a run that ends in %s with 502, its outcome, and its stamp', async (outcome, run, error) => {
    h.runner.mockResolvedValue(run);
    const res = await invoke(LIVE_ID, { input: { load: 1, span: 2 } });
    expect(res).toEqual({ status: 502, body: { error, outcome, stamp } });
  });

  it('answers a run past its time limit with 504 request_timeout', async () => {
    h.runner.mockResolvedValue({ outcome: 'timeout', reason: 'timeout', durationMs: 30_000 });
    const res = await invoke(LIVE_ID, { input: { load: 1, span: 2 } });
    expect(res).toEqual({
      status: 504,
      body: { error: 'The call ran past its time limit.', errorCode: 'request_timeout', stamp },
    });
  });

  it('answers 503 when no runtime is configured', async () => {
    h.runnerConfigured.value = false;
    expect(await invoke(LIVE_ID, { input: { load: 1, span: 2 } })).toEqual({
      status: 503,
      body: { error: 'No function runtime is available.' },
    });
  });

  it('answers 503 asking for a retry when the runtime fails, not 502', async () => {
    h.runner.mockRejectedValue(new Error('runtime went away'));
    expect(await invoke(LIVE_ID, { input: { load: 1, span: 2 } })).toEqual({
      status: 503,
      body: { error: 'The function runtime did not answer. Try again later.' },
    });
    expect(h.calls).toEqual([expect.objectContaining({ outcome: 'error', reason: 'runtime_unavailable' })]);
  });

  it('names the field, the limit, and the length when an output text is too long', () => {
    const problems = [
      { path: 'report', message: 'must be at most 2000 characters (it has 4000000)' },
      { path: 'note', message: 'must be at most 500 characters (it has 900)' },
    ];
    const answer = invokeAnswer({ outcome: 'output_invalid', problems, durationMs: 1, callId: 'c' });
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe(
      'The function returned outputs that do not fit its output schema. Output report must be at most 2000 characters (it has 4000000) (and 1 more).'
    );
  });

  it('keeps the plain output refusal when the contract or result could not be read', () => {
    const answer = invokeAnswer({
      outcome: 'output_invalid',
      reason: 'result_not_json',
      problems: [{ path: 'inputs.x', message: 'is not valid' }],
      durationMs: 1,
      callId: 'c',
    });
    expect(answer.body.error).toBe('The function returned outputs that do not fit its output schema.');
  });

  it('answers 503 when the runtime never replied', () => {
    expect(invokeAnswer({ outcome: 'error', reason: 'no_reply', durationMs: 105_000, callId: 'c' })).toEqual({
      status: 503,
      body: { error: 'The function runtime did not answer. Try again later.' },
    });
  });

  it('answers 503 when the runtime was slow to start', () => {
    expect(invokeAnswer({ outcome: 'error', reason: 'start_timeout', durationMs: 60_000, callId: 'c' })).toEqual({
      status: 503,
      body: { error: 'The function runtime did not answer. Try again later.' },
    });
  });

  it.each(['payload_invalid', 'pyodide_version'])('answers 503 when the runtime refuses with %s', reason => {
    expect(invokeAnswer({ outcome: 'refused', reason, durationMs: 0, callId: 'c' })).toEqual({
      status: 503,
      body: { error: 'The function runtime did not answer. Try again later.' },
    });
  });

  it.each(['not_found', 'not_caller', 'disabled', 'source_deleted'])(
    'answers 404 when the call is refused with %s',
    reason => {
      expect(invokeAnswer({ outcome: 'refused', reason, durationMs: 0, callId: 'c' })).toEqual({
        status: 404,
        body: { error: 'Function not found' },
      });
    }
  );

  it('answers 502 naming output_too_large when the function returns more than a call can carry', () => {
    expect(
      invokeAnswer({ outcome: 'output_too_large', reason: 'result_too_large', durationMs: 1, callId: 'c' })
    ).toEqual({
      status: 502,
      body: { error: 'The function returned more than a call can carry.', outcome: 'output_too_large' },
    });
  });

  it('answers 504 request_timeout from the dispatcher at the route budget, inside the web timeout, with one row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      h.runner.mockImplementation(() => new Promise(() => undefined));
      const pending = invoke(LIVE_ID, { input: { load: 1, span: 2 } });
      await vi.advanceTimersByTimeAsync(FUNCTION_INVOKE_BUDGET_MS);
      const res = await pending;
      expect(res).toEqual({
        status: 504,
        body: { error: 'The call ran past its time limit.', errorCode: 'request_timeout', stamp },
      });
      expect(h.calls).toEqual([
        expect.objectContaining({ surface: 'rest', outcome: 'timeout', reason: 'wait_exceeded' }),
      ]);
      expect(FUNCTION_INVOKE_BUDGET_MS).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 504 request_timeout when the budget ran out before the run', () => {
    expect(invokeAnswer({ outcome: 'refused', reason: 'budget_exhausted', durationMs: 0, callId: 'c' })).toEqual({
      status: 504,
      body: { error: 'The call ran past its time limit.', errorCode: 'request_timeout' },
    });
  });

  it('answers an input over the surface cap with 413', () => {
    expect(invokeAnswer({ outcome: 'input_invalid', reason: 'input_too_large', durationMs: 0, callId: 'c' })).toEqual({
      status: 413,
      body: { error: 'The input is larger than a call accepts.' },
    });
  });

  it("raises Next's body parser limit above the route's own body cap", () => {
    expect(invokeConfig.api.bodyParser.sizeLimit).toBe('6mb');
    expect(FUNCTION_INVOKE_MAX_BODY_BYTES).toBeLessThanOrEqual(6 * 1024 * 1024);
  });
});

describe('synchronous stop', () => {
  const pastBudget = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.runner.mockImplementation(() => new Promise(() => undefined));
      const pending = invoke(LIVE_ID, { input: { load: 1, span: 2 } });
      await vi.advanceTimersByTimeAsync(FUNCTION_INVOKE_BUDGET_MS);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  it('stops at 45 s and names async mode when the organization allows a longer run', async () => {
    h.limitMs.value = 300_000;
    const res = await pastBudget();
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: FUNCTION_SYNC_STOP_MESSAGE, errorCode: 'request_timeout' });
    expect(FUNCTION_SYNC_STOP_MESSAGE).toContain('"mode": "async"');
    // The route's deadline starts at the request's arrival, so the run gets what is left of the 45 s.
    const { timeoutMs } = h.runner.mock.calls[0][0].limits;
    expect(timeoutMs).toBeLessThanOrEqual(FUNCTION_INVOKE_BUDGET_MS);
    expect(timeoutMs).toBeGreaterThan(FUNCTION_INVOKE_BUDGET_MS - 5_000);
  });

  it('does not name async mode when async mode would stop at the same limit', async () => {
    h.limitMs.value = 40_000;
    const res = await pastBudget();
    expect(res.body.error).toBe(TIMEOUT_MESSAGE);
    expect(h.runner.mock.calls[0][0].limits.timeoutMs).toBe(40_000);
  });

  it('says async mode is unavailable on self-host instead of pointing to it', async () => {
    h.limitMs.value = 300_000;
    h.runner.mockResolvedValue({ outcome: 'timeout', durationMs: 45_000 });
    vi.stubEnv('B4M_SELF_HOST', 'true');
    try {
      const res = await invoke(LIVE_ID, { input: { load: 1, span: 2 } });
      expect(res.status).toBe(504);
      expect(res.body.error).toBe(FUNCTION_SYNC_STOP_SELF_HOST_MESSAGE);
      expect(res.body.error).not.toContain('"mode": "async"');
      expect(res.body.error).toContain('not available on self-hosted installs');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names async mode when the runtime stops a run the 45 s cap cut short', async () => {
    h.limitMs.value = 300_000;
    h.runner.mockResolvedValue({ outcome: 'timeout', durationMs: 45_000 });
    const res = await invoke(LIVE_ID, { input: { load: 1, span: 2 } });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe(FUNCTION_SYNC_STOP_MESSAGE);
  });
});

describe('async invoke and poll', () => {
  const asyncInvoke = (id = LIVE_ID, input: Record<string, unknown> = { load: 1, span: 2 }) =>
    invoke(id, { input, mode: 'async' });
  const poll = (callId: string, user?: string) => call(pollRoute, { query: { call_id: callId }, user });

  it('answers 202 with a call id after the checks, writes one queued row, and sends one job without inputs', async () => {
    const res = await asyncInvoke();
    expect(res.status).toBe(202);
    const callId = res.body.call_id as string;
    expect(res.body).toEqual({ call_id: callId, status: 'queued' });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ outcome: 'queued', surface: 'rest', apiKeyId: 'k1' });
    expect(h.sent).toEqual([{ url: 'queue://callableFunctionCallQueue', message: { callId } }]);
    expect(h.results.get(callId)).toMatchObject({ state: 'queued', input: { load: 1, span: 2 } });
  });

  it.each([
    ['an input that does not fit', LIVE_ID, { load: 1, span: 'four' }, 422],
    ['a draft', DRAFT_ID, { load: 1, span: 2 }, 404],
    ["another person's function", OTHERS_ID, { load: 1, span: 2 }, 404],
  ])('refuses %s before anything is queued', async (_name, id, input, status) => {
    const res = await asyncInvoke(id, input);
    expect(res.status).toBe(status);
    expect(h.sent).toHaveLength(0);
    expect(h.results.size).toBe(0);
  });

  it('answers 503 on self-host before any row, result, or job is written', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    try {
      const res = await asyncInvoke();
      expect(res).toEqual({
        status: 503,
        body: { error: 'Asynchronous calls are not available on self-hosted installs.' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(h.calls).toHaveLength(0);
    expect(h.results.size).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('answers 503 and keeps nothing queued when the job cannot be sent', async () => {
    h.sendFails.value = true;
    const res = await asyncInvoke();
    expect(res.status).toBe(503);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ outcome: 'error', reason: 'queue_failed' });
    expect([...h.results.values()][0]).toMatchObject({ state: 'finished', outcome: 'error' });
  });

  it("answers 429 naming the cap once the caller's queued and running calls reach it, and queues nothing", async () => {
    h.pendingLimit.value = 2;
    const first = (await asyncInvoke()).body.call_id as string;
    expect((await asyncInvoke()).status).toBe(202);
    h.results.set(first, { ...h.results.get(first), state: 'running' });

    const refused = await asyncInvoke();
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain('At most 2 asynchronous calls');
    // The route's error handler spreads additionalInfo into the body; this file's `call` keeps only the message.
    const request = { caller: { id: 'u1' }, functionId: LIVE_ID, args: { load: 1, span: 2 }, surface: 'rest' as const };
    await expect(queueFunctionCall(request, { send: async () => undefined })).rejects.toMatchObject({
      statusCode: 429,
      additionalInfo: { errorCode: 'concurrency_limit_exceeded', limit: 2 },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.sent).toHaveLength(2);

    h.results.set(first, { ...h.results.get(first), state: 'finished', outcome: 'ok' });
    expect((await asyncInvoke()).status).toBe(202);
  });

  it('polls queued, running, then the output and stamp', async () => {
    const callId = (await asyncInvoke()).body.call_id as string;
    expect((await poll(callId)).body).toEqual({ call_id: callId, status: 'queued' });
    h.results.set(callId, { ...h.results.get(callId), state: 'running' });
    expect((await poll(callId)).body).toEqual({ call_id: callId, status: 'running' });
    const stamp = { function_id: LIVE_ID, surface: 'rest' };
    const outputs = { deflection: 2 };
    h.results.set(callId, { ...h.results.get(callId), state: 'finished', outcome: 'ok', outputs, stamp });
    const done = await poll(callId);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ call_id: callId, status: 'finished', outcome: 'ok', output: outputs, stamp });
  });

  it('polls a call that ran out of time as finished with outcome timeout', async () => {
    const callId = (await asyncInvoke()).body.call_id as string;
    h.results.set(callId, { ...h.results.get(callId), state: 'finished', outcome: 'timeout' });
    expect((await poll(callId)).body).toMatchObject({
      status: 'finished',
      outcome: 'timeout',
      error: TIMEOUT_MESSAGE,
    });
  });

  it.each(['worker_lost', 'dispatch_failed'] as const)(
    'polls a call ended as %s as stopped before it finished, not as a function error',
    reason => {
      const answer = functionCallAnswer({
        callId: 'c1',
        state: 'finished',
        outcome: 'error',
        reason,
      } as Parameters<typeof functionCallAnswer>[0]);
      expect(answer).toEqual({
        call_id: 'c1',
        status: 'finished',
        outcome: 'error',
        error: FUNCTION_CALL_STOPPED_MESSAGE,
      });
    }
  );

  it('still polls a call whose function raised as a function error', () => {
    const answer = functionCallAnswer({
      callId: 'c1',
      state: 'finished',
      outcome: 'error',
      errorClass: 'ValueError',
    } as Parameters<typeof functionCallAnswer>[0]);
    expect(answer.error).toBe('The function raised an error (ValueError).');
  });

  it('polls an over-long output text with the field, the limit, and the length', () => {
    const problems = [{ path: 'report', message: 'must be at most 2000 characters (it has 4000000)' }];
    const answer = functionCallAnswer({
      callId: 'c1',
      state: 'finished',
      outcome: 'output_invalid',
      problems,
    } as Parameters<typeof functionCallAnswer>[0]);
    expect(answer).toEqual({
      call_id: 'c1',
      status: 'finished',
      outcome: 'output_invalid',
      error:
        'The function returned outputs that do not fit its output schema. Output report must be at most 2000 characters (it has 4000000).',
      problems,
    });
  });

  it("answers another person's call id exactly as a made-up or malformed one", async () => {
    const callId = (await asyncInvoke()).body.call_id as string;
    const theirs = await poll(callId, 'u2');
    const madeUp = await poll('6c9999999999999999999999');
    const malformed = await poll('not-an-id');
    expect(theirs).toEqual({ status: 404, body: { error: 'Call not found' } });
    expect(madeUp).toEqual(theirs);
    expect(malformed).toEqual(theirs);
  });

  it('answers 403 on the poll when callable functions are off', async () => {
    const callId = (await asyncInvoke()).body.call_id as string;
    h.enabled.value = false;
    expect((await poll(callId)).status).toBe(403);
  });
});
