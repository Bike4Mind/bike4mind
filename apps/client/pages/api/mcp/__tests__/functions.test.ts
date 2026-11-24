// @vitest-environment node
/**
 * The hosted functions MCP endpoint, driven by the MCP SDK's own client over in-memory requests to the handler.
 * `baseApi` is a stand-in that applies the route's method list and scope gate; the database, the settings, and the
 * runtime are stubbed; the registry, the dispatcher, and the input and output checks run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ApiKeyScope, TooManyRequestsError, type FunctionContract } from '@bike4mind/common';
import type {
  CallableFunctionRunPayload,
  CallableFunctionRunResult,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

type Mw = (req: Record<string, unknown>, res: unknown, next: (error?: unknown) => void) => unknown;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
  rateLimitOptions: [] as Array<{ bucket?: string }>,
  limited: { value: false },
  enabled: { value: true },
  mcpEnabled: { value: true },
  functions: [] as Record<string, unknown>[],
  artifacts: [] as { id: string; userId: string; version: number; deletedAt: Date | null }[],
  calls: [] as Record<string, unknown>[],
  runner: vi.fn(),
  listForOwner: vi.fn(),
  findBySlug: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const { decideScopeGate: gate } = await import('@bike4mind/server-utils/middlewares/apiKeyScopeGate');
  const { ForbiddenError, MethodNotAllowedError } = await import('@bike4mind/common');
  return {
    baseApi: (options?: { requiredScopes?: ApiKeyScope[]; allowedMethods?: string[] }) => {
      h.baseApiOptions.push(options);
      const used: Mw[] = [
        (req, _res, next) => {
          if (options?.allowedMethods && !options.allowedMethods.includes(req.method as string)) {
            throw new MethodNotAllowedError(`Method ${String(req.method)} not allowed`);
          }
          next();
        },
        (req, _res, next) => {
          const key = req.apiKeyInfo as { scopes: ApiKeyScope[] } | undefined;
          if (key && gate(options?.requiredScopes, key.scopes, new Set()).outcome !== 'allow') {
            throw new ForbiddenError('Insufficient API key permissions', { required_scopes: options?.requiredScopes });
          }
          next();
        },
      ];
      const chain: Record<string, unknown> = {};
      chain.use = (mw: Mw) => {
        used.push(mw);
        return chain;
      };
      chain.post = (route: Mw) => async (req: Record<string, unknown>, res: unknown) => {
        for (const handler of [...used, route]) {
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
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: { bucket?: string }) => {
    h.rateLimitOptions.push(options);
    return (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next(h.limited.value ? new TooManyRequestsError('Rate limit exceeded.') : undefined);
  },
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: async () => h.enabled.value,
  resolveCallableFunctionsMcpEnabled: async () => h.enabled.value && h.mcpEnabled.value,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/runtimeRunner', () => ({
  selectCallableFunctionRunner: () => h.runner,
}));

type Owner = { ownerType: string; ownerKey: string };
const owned = (owner: Owner) => (fn: Record<string, unknown>) => fn.ownerKey === owner.ownerKey;

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  artifactContentRepository: {},
  callableFunctionRepository: {
    findById: async (id: string) => h.functions.find(fn => fn.id === id) ?? null,
    findByIdForOwner: async (id: string, owner: Owner) =>
      h.functions.find(fn => fn.id === id && owned(owner)(fn)) ?? null,
    findBySlugForOwner: (slug: string, owner: Owner) => h.findBySlug(slug, owner),
    listForOwner: (owner: Owner) => h.listForOwner(owner),
  },
  artifactRepository: {
    find: async (filter: { id: { $in: string[] }; userId: string }) =>
      h.artifacts.filter(a => filter.id.$in.includes(a.id) && a.userId === filter.userId),
    findOne: async (filter: { id: string; userId: string }) =>
      h.artifacts.find(a => a.id === filter.id && a.userId === filter.userId) ?? null,
  },
  callableFunctionCallRepository: {
    record: async (row: Record<string, unknown>) => {
      h.calls.push(row);
      return { ...row, id: `call-${h.calls.length}` };
    },
  },
}));

const { default: route, config } = await import('@pages/api/mcp/functions');
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

interface Caller {
  user?: string;
  /** null: a browser session, no key. */
  scopes?: ApiKeyScope[] | null;
}

interface Exchange {
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

let exchanges: Exchange[] = [];

type AnyHandler = (req: unknown, res: unknown) => Promise<unknown>;

/** A fetch that hands each request to the route in memory, as the API-key chain would leave it. */
function inMemoryFetch({ user = 'u1', scopes = [ApiKeyScope.FUNCTIONS_INVOKE] }: Caller = {}) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const requestHeaders: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      requestHeaders[name] = value;
    });
    const method = (init?.method ?? 'GET').toUpperCase();
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const { req, res } = createMocks({
      method: method as 'POST',
      url: new URL(url).pathname,
      headers: requestHeaders,
      body: text ? (JSON.parse(text) as object) : undefined,
    });
    Object.assign(req, {
      user: { id: user },
      logger,
      ...(scopes ? { apiKeyInfo: { keyId: `key-${user}`, scopes } } : {}),
    });
    let status: number;
    let body: string | null;
    let responseHeaders: Record<string, string> = {};
    try {
      await (route as AnyHandler)(req, res);
      status = res._getStatusCode();
      const data = res._getData() as string;
      body = data ? data : null;
      for (const [name, value] of Object.entries(res._getHeaders())) responseHeaders[name] = String(value);
    } catch (error) {
      const failure = error as { statusCode?: number; message: string; additionalInfo?: Record<string, unknown> };
      status = failure.statusCode ?? 500;
      body = JSON.stringify({ error: failure.message, ...failure.additionalInfo });
      responseHeaders = { 'content-type': 'application/json' };
    }
    exchanges.push({ method, status, requestHeaders, responseHeaders });
    return new Response(status === 202 || status === 204 ? null : body, { status, headers: responseHeaders });
  };
}

async function connect(caller: Caller = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/functions'), {
    fetch: inMemoryFetch(caller),
  });
  await client.connect(transport);
  return client;
}

/** One JSON-RPC message posted on its own, with no initialize before it. */
async function post(
  message: Record<string, unknown> | Record<string, unknown>[],
  extraHeaders: Record<string, string> = {}
) {
  const res = await inMemoryFetch()('http://localhost/api/mcp/functions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify(message),
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
}

const callResult = (result: unknown) =>
  result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  exchanges = [];
  h.limited.value = false;
  h.enabled.value = true;
  h.mcpEnabled.value = true;
  h.calls = [];
  h.functions = [
    fnDoc('6b0000000000000000000001'),
    fnDoc('6b0000000000000000000002', { slug: 'beam_draft', state: 'draft', trustLabel: undefined }),
    fnDoc('6b0000000000000000000003', { slug: 'beam_other', ownerKey: 'u2', userId: 'u2' }),
  ];
  h.artifacts = h.functions.map(fn => ({
    id: (fn.pin as { artifactId: string }).artifactId,
    userId: fn.userId as string,
    version: 5,
    deletedAt: null,
  }));
  h.runner.mockImplementation(async (_payload: CallableFunctionRunPayload) => okRun());
  // Copies, ordered by creation as the model's query is, so a later change to a stored function is not seen by a read already made.
  h.listForOwner.mockImplementation(async (owner: Owner) =>
    h.functions
      .filter(owned(owner))
      .map(fn => ({ ...fn }))
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
  );
  h.findBySlug.mockImplementation(async (slug: string, owner: Owner) => {
    const found = h.functions.find(fn => fn.slug === slug && owned(owner)(fn));
    return found ? { ...found } : null;
  });
});

describe('route wiring', () => {
  it('needs functions:invoke, serves POST only, and takes a body as large as the input cap', () => {
    expect(h.baseApiOptions[0]).toMatchObject({
      requiredScopes: [ApiKeyScope.FUNCTIONS_INVOKE],
      allowedMethods: ['POST'],
    });
    expect(h.baseApiOptions[0]?.maxBodySize).toBeGreaterThan(5 * 1024 * 1024);
    expect(config.api.bodyParser.sizeLimit).toBe('6mb');
  });

  it('uses its own per-user rate-limit bucket', () => {
    expect(rateLimitBuckets).toEqual(['/api/mcp/functions']);
  });
});

describe('tools/list', () => {
  it("lists only the owner's live functions, with both schemas and the read-only hint", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      {
        name: 'beam_midspan_deflection',
        description: CONTRACT.description,
        inputSchema: CONTRACT.inputs,
        outputSchema: CONTRACT.outputs,
        annotations: { readOnlyHint: true },
      },
    ]);
    await client.close();
  });

  it('lists up to the 100-function cap, in the order the functions were created', async () => {
    const count = 100;
    h.functions = Array.from({ length: count }, (_, i) =>
      fnDoc(`6b${String(i).padStart(22, '0')}`, {
        slug: `fn_${String(i).padStart(3, '0')}`,
        createdAt: new Date(T0.getTime() + (count - i) * 1000),
      })
    );
    h.artifacts = h.functions.map(fn => ({
      id: (fn.pin as { artifactId: string }).artifactId,
      userId: 'u1',
      version: 5,
      deletedAt: null,
    }));
    const client = await connect();
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toHaveLength(count);
    expect(names).toEqual(Array.from({ length: count }, (_, i) => `fn_${String(count - 1 - i).padStart(3, '0')}`));
    await client.close();
  });

  it('leaves out a function that stopped being live after the list was read, and lists the rest', async () => {
    h.functions.push(
      fnDoc('6b0000000000000000000004', { slug: 'beam_second' }),
      fnDoc('6b0000000000000000000005', { slug: 'beam_removed' })
    );
    h.artifacts = h.functions.map(fn => ({
      id: (fn.pin as { artifactId: string }).artifactId,
      userId: fn.userId as string,
      version: 5,
      deletedAt: null,
    }));
    h.listForOwner.mockImplementationOnce(async (owner: Owner) => {
      const read = h.functions.filter(owned(owner)).map(fn => ({ ...fn }));
      h.functions.find(fn => fn.slug === 'beam_midspan_deflection')!.state = 'draft';
      h.functions = h.functions.filter(fn => fn.slug !== 'beam_removed');
      return read;
    });
    const client = await connect();
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['beam_second']);
    await client.close();
  });
});

describe('tools/call', () => {
  it('finds the function by its name in one owner lookup, without listing them all', async () => {
    const client = await connect();
    await client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } });
    expect(h.findBySlug).toHaveBeenCalledWith('beam_midspan_deflection', { ownerType: 'user', ownerKey: 'u1' });
    expect(h.listForOwner).not.toHaveBeenCalled();
    await client.close();
  });

  it('returns the output as structuredContent, a text block with output and stamp, and the stamp in _meta', async () => {
    const client = await connect();
    await client.listTools();
    // The SDK client checks structuredContent against the listed outputSchema and throws when it does not match.
    const result = callResult(
      await client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } })
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ deflection: 0.0081 });
    const stamp = result._meta?.stamp as Record<string, unknown>;
    expect(stamp).toMatchObject({ slug: 'beam_midspan_deflection', surface: 'mcp', pin_version: 5, pin_seq: 2 });
    expect(JSON.parse(result.content[0].text)).toEqual({ output: { deflection: 0.0081 }, stamp });
    expect(h.calls).toEqual([
      expect.objectContaining({ surface: 'mcp', apiKeyId: 'key-u1', callerUserId: 'u1', outcome: 'ok' }),
    ]);
    await client.close();
  });

  it('answers bad input with an isError result naming the field, without running', async () => {
    const client = await connect();
    const result = callResult(
      await client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 'four' } })
    );
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Input span must be a number.' }] });
    expect(h.runner).not.toHaveBeenCalled();
    await client.close();
  });

  it('answers a draft and another person function exactly as a missing one, without running', async () => {
    const client = await connect();
    const answers = [];
    for (const name of ['beam_draft', 'beam_other', 'no_such_function']) {
      answers.push(callResult(await client.callTool({ name, arguments: { load: 2, span: 4 } })));
    }
    expect(answers[0]).toEqual({ isError: true, content: [{ type: 'text', text: 'Function not found' }] });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(h.runner).not.toHaveBeenCalled();
    await client.close();
  });

  it('answers outputs that do not fit the output schema with an isError result and the stamp', async () => {
    h.runner.mockImplementation(async () => okRun({ deflection: 'tall' }));
    const client = await connect();
    const result = callResult(
      await client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } })
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toBe('The function returned outputs that do not fit its output schema.');
    expect(result._meta?.stamp).toMatchObject({ surface: 'mcp' });
    await client.close();
  });

  describe('with a function that returns text', () => {
    const TEXT_CONTRACT: FunctionContract = {
      ...CONTRACT,
      name: 'echo_text',
      inputs: { type: 'object', properties: {}, additionalProperties: false },
      outputs: {
        type: 'object',
        properties: { lines: { type: 'array', items: { type: 'string' } } },
        required: ['lines'],
        additionalProperties: false,
      },
    };
    // A string field holds at most 2000 characters, so a large output is a list of lines of 1000 bytes each.
    const textOutput = (lines: number) => okRun({ lines: Array.from({ length: lines }, () => 'x'.repeat(1000)) });

    beforeEach(() => {
      h.functions.push(fnDoc('6b0000000000000000000009', { slug: 'echo_text', contract: TEXT_CONTRACT }));
      h.artifacts.push({ id: 'artifact-6b0000000000000000000009', userId: 'u1', version: 5, deletedAt: null });
    });

    it('answers an output over 2 MiB with the too-large text, the stamp, and no output', async () => {
      h.runner.mockImplementation(async () => textOutput(2100));
      const client = await connect();
      const result = callResult(await client.callTool({ name: 'echo_text', arguments: {} }));
      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'The function returned more than a call can carry.' }],
        _meta: { stamp: expect.objectContaining({ slug: 'echo_text', surface: 'mcp' }) },
      });
      expect(h.calls).toEqual([expect.objectContaining({ surface: 'mcp', outcome: 'output_too_large' })]);
      await client.close();
    });

    it('carries an output just under 2 MiB twice and stays under the 6 MB response limit', async () => {
      h.runner.mockImplementation(async () => textOutput(2080));
      const client = await connect();
      const result = callResult(await client.callTool({ name: 'echo_text', arguments: {} }));
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { lines: string[] }).lines).toHaveLength(2080);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6 * 1000 * 1000);
      await client.close();
    });
  });

  it('answers a call that outlasts the 45 second budget with the time-limit text', async () => {
    vi.useFakeTimers();
    try {
      h.runner.mockImplementation(() => new Promise(() => {}));
      const answer = post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } },
      });
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await answer).json).toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: { isError: true, content: [{ type: 'text', text: 'The call ran past its time limit.' }] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one message per request', () => {
  it('answers a batch with 400 and a fixed error, before anything runs or is logged', async () => {
    const call = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } },
    });
    const answer = await post([call(1), call(2)]);
    expect(answer.status).toBe(400);
    expect(answer.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Send one message per request.' },
    });
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });
});

describe('a store failure', () => {
  const STORE_FAILURE = 'connection 3 to db-internal-7.example.net:27017 closed';

  it.each([
    [
      'tools/list',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } },
      () => h.listForOwner.mockRejectedValue(new Error(STORE_FAILURE)),
    ],
    [
      'tools/call',
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'beam_midspan_deflection', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 2,
        result: { isError: true, content: [{ type: 'text', text: 'Internal error' }] },
      },
      () => h.findBySlug.mockRejectedValue(new Error(STORE_FAILURE)),
    ],
  ])('on %s is logged with its cause and answered with a fixed message', async (method, message, expected, fail) => {
    fail();
    const answer = await post(message);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(expected);
    expect(JSON.stringify(answer.json)).not.toContain('example.net');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(`[mcp/functions] ${method} failed`, {
      name: 'Error',
      message: STORE_FAILURE,
    });
    expect(h.runner).not.toHaveBeenCalled();
  });
});

/** The SDK client's error for an HTTP refusal: `code` is the status and the message carries the body. */
const refusal = (code: number, body: Record<string, unknown>) =>
  expect.objectContaining({
    code,
    message: `Streamable HTTP error: Error POSTing to endpoint: ${JSON.stringify(body)}`,
  });

describe('refusals before any MCP message is read', () => {
  it('refuses a key without functions:invoke with 403 naming the scope', async () => {
    await expect(connect({ scopes: [ApiKeyScope.AI_CHAT] })).rejects.toEqual(
      refusal(403, { error: 'Insufficient API key permissions', required_scopes: [ApiKeyScope.FUNCTIONS_INVOKE] })
    );
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a session without an API key', async () => {
    await expect(connect({ scopes: null })).rejects.toEqual(
      refusal(403, { error: 'This endpoint takes an API key holding the functions:invoke scope.' })
    );
  });

  it('refuses every request while the MCP setting is off, even with callable functions on', async () => {
    h.mcpEnabled.value = false;
    await expect(connect()).rejects.toEqual(
      refusal(403, { error: 'Callable functions over MCP are turned off for this account.' })
    );
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.status).toBe(403);
    expect(h.runner).not.toHaveBeenCalled();
  });

  it('answers 429 from the limiter before any function is read or run', async () => {
    const client = await connect();
    h.limited.value = true;
    await expect(client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } })).rejects.toEqual(
      refusal(429, { error: 'Rate limit exceeded.' })
    );
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });
});

describe('statelessness', () => {
  it('never issues a session id and answers GET with 405', async () => {
    const client = await connect();
    await client.listTools();
    await client.callTool({ name: 'beam_midspan_deflection', arguments: { load: 2, span: 4 } });
    await client.close();
    expect(exchanges.length).toBeGreaterThanOrEqual(4);
    expect(exchanges.filter(e => 'mcp-session-id' in e.responseHeaders)).toEqual([]);
    expect(exchanges.filter(e => 'mcp-session-id' in e.requestHeaders)).toEqual([]);
    expect(exchanges.filter(e => e.method === 'GET').map(e => e.status)).toEqual([405]);
  });

  it('serves a lone request with no initialize before it, and ignores a session id it never issued', async () => {
    const list = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { 'mcp-session-id': 'made-up-session' });
    expect(list.status).toBe(200);
    expect(list.headers.get('mcp-session-id')).toBeNull();
    expect((list.json.result as { tools: Array<{ name: string }> }).tools.map(t => t.name)).toEqual([
      'beam_midspan_deflection',
    ]);
  });

  it('carries nothing from one caller to the next', async () => {
    const first = await connect({ user: 'u1' });
    expect((await first.listTools()).tools.map(t => t.name)).toEqual(['beam_midspan_deflection']);
    const second = await connect({ user: 'u2' });
    expect((await second.listTools()).tools.map(t => t.name)).toEqual(['beam_other']);
    expect((await first.listTools()).tools.map(t => t.name)).toEqual(['beam_midspan_deflection']);
    await first.close();
    await second.close();
  });
});
