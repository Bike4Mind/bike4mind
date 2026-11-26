// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseFunctionContract,
  projectFunctionSchema,
  reviewHash,
  validateFunctionValue,
  type CallableFunctionCallOutcome,
  type CallableFunctionStamp,
  type FunctionContract,
} from '@bike4mind/common';
import { generateCustomMcpTools, loadCustomMcpConnections } from '@bike4mind/services/llm';
import { buildCallableFunctionStamp, type DispatchFunctionCallResult } from './dispatch';

const h = vi.hoisted(() => ({
  functionsOn: true,
  customMcpOn: false,
  offered: [] as Record<string, unknown>[],
  bySlug: null as Record<string, unknown> | null,
  reads: [] as string[],
}));

vi.mock('./access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => {
    h.reads.push('functions setting');
    return h.functionsOn;
  }),
}));
vi.mock('./registry', () => ({
  listOfferedCallableFunctions: vi.fn(async () => {
    h.reads.push('offered');
    return h.offered;
  }),
}));
vi.mock('../mcpConnections/customMcpAccess', () => ({
  resolveCustomMcpContext: vi.fn(async () => ({ enabled: h.customMcpOn, policies: [] })),
  evaluateConnectionPolicy: vi.fn(() => ({ allowed: true })),
}));
vi.mock('../mcpConnections/invokeRemoteMcp', () => ({ invokeRemoteMcp: vi.fn() }));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  callableFunctionRepository: { findBySlugForOwner: vi.fn(async () => h.bySlug) },
  callableFunctionCallRepository: { record: vi.fn(async () => ({ id: 'row' })) },
  mcpConnectionRepository: {
    listForUser: vi.fn(async () => [
      {
        id: 'conn-1',
        slug: 'docs',
        displayName: 'Docs',
        urlHost: 'mcp.example.com',
        displayUrl: 'https://mcp.example.com',
        auth: { kind: 'none' },
        tools: [],
      },
    ]),
  },
}));

import {
  FUNCTION_ANSWER_RESERVE_MS,
  FUNCTION_CONNECTION_ID,
  FUNCTION_MIN_WAIT_MS,
  MAX_FUNCTION_TOOLS_PER_TURN,
  createFunctionToolHost,
  functionAndConnectorToolHost,
} from './functionToolHost';
import { listOfferedCallableFunctions } from './registry';

const USER = 'owner-1';
const parsed = parseFunctionContract({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span'],
    properties: { load: { type: 'number', unit: 'N/m' }, span: { type: 'number', unit: 'm' } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT: FunctionContract = parsed.contract;

const fn = (overrides: Record<string, unknown> = {}) => ({
  id: '6650f0a1b2c3d4e5f6a7b8c9',
  slug: CONTRACT.name,
  state: 'live',
  enabled: true,
  approval: 'default',
  contract: CONTRACT,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  pin: { artifactId: 'artifact-1', version: 3 },
  ...overrides,
});

const STAMP = { function_id: 'f', slug: CONTRACT.name, trust_label: 'verified' } as unknown as CallableFunctionStamp;
type RanResult = DispatchFunctionCallResult<CallableFunctionCallOutcome>;
const dispatched = (overrides: Partial<RanResult> = {}): RanResult => ({
  outcome: 'ok',
  outputs: { deflection: 0.0042 },
  stamp: STAMP,
  durationMs: 12,
  callId: 'call-1',
  ...overrides,
});

const logger = { warn: vi.fn() };

beforeEach(() => {
  h.functionsOn = true;
  h.customMcpOn = false;
  h.offered = [fn()];
  h.bySlug = fn();
  h.reads = [];
});

describe('listing', () => {
  it('lists nothing with the callable functions setting off, and reads no function', async () => {
    h.functionsOn = false;
    expect(await createFunctionToolHost('chat').listConnections(USER)).toEqual([]);
    expect(h.reads).toEqual(['functions setting']);
  });

  it('still lists functions with custom connectors off, ahead of any connector', async () => {
    const offers = await functionAndConnectorToolHost('chat').listConnections(USER);
    expect(offers.map(offer => offer.connectionId)).toEqual([FUNCTION_CONNECTION_ID]);

    h.customMcpOn = true;
    const both = await functionAndConnectorToolHost('chat').listConnections(USER);
    expect(both.map(offer => offer.slug)).toEqual(['_fn', 'docs']);
  });

  it('offers each function under the llm projection, read-only, with its approval and review hash', async () => {
    const [offer] = await createFunctionToolHost('chat').listConnections(USER);
    const llm = projectFunctionSchema(CONTRACT, 'llm');
    const hash = await reviewHash(CONTRACT);
    expect(offer).toMatchObject({
      connectionId: '_fn',
      slug: '_fn',
      displayName: 'Functions',
      urlHost: 'functions',
      allowWriteTools: true,
      requireApprovalForAll: false,
    });
    expect(offer!.tools).toEqual([
      {
        name: CONTRACT.name,
        description: llm.description,
        inputSchema: llm.parameters,
        outputSchema: projectFunctionSchema(CONTRACT, 'mcp').outputSchema,
        annotations: { readOnlyHint: true },
        approval: 'default',
        state: 'active',
        enabled: true,
        descriptionRawHash: hash,
        versionHash: hash,
        firstSeenAt: new Date('2026-11-01T00:00:00Z'),
      },
    ]);
  });

  it('leaves always-ask functions out of a headless turn only', async () => {
    h.offered = [fn(), fn({ slug: 'asks_first', approval: 'always_ask' })];
    const names = async (headless: boolean) =>
      (await createFunctionToolHost('chat').listConnections(USER, { headless }))[0]!.tools.map(tool => tool.name);
    expect(await names(false)).toEqual([CONTRACT.name, 'asks_first']);
    expect(await names(true)).toEqual([CONTRACT.name]);
  });

  it('lists nothing when no function is offerable, and caps the offer so connectors keep room', async () => {
    h.offered = [];
    expect(await createFunctionToolHost('chat').listConnections(USER)).toEqual([]);

    h.offered = Array.from({ length: MAX_FUNCTION_TOOLS_PER_TURN + 5 }, (_, i) => fn({ slug: `tool_${i}` }));
    const [offer] = await createFunctionToolHost('chat').listConnections(USER);
    expect(offer!.tools).toHaveLength(MAX_FUNCTION_TOOLS_PER_TURN);
  });

  it('bounds the read at the cap, leaving always-ask functions out of it for a headless turn', async () => {
    vi.mocked(listOfferedCallableFunctions).mockClear();
    await createFunctionToolHost('chat').listConnections(USER, { headless: true });
    await createFunctionToolHost('chat').listConnections(USER);
    expect(vi.mocked(listOfferedCallableFunctions).mock.calls.map(([, options]) => options)).toEqual([
      { limit: 20, excludeAlwaysAsk: true },
      { limit: 20, excludeAlwaysAsk: undefined },
    ]);
  });

  it('lists the functions but no connector when the MCP server is off, even with custom connectors on', async () => {
    h.customMcpOn = true;
    const host = functionAndConnectorToolHost('chat');

    const off = await host.listConnections(USER, { mcpServerOff: true });
    const on = await host.listConnections(USER);

    expect(off.map(offer => offer.slug)).toEqual(['_fn']);
    expect(on.map(offer => offer.slug)).toEqual(['_fn', 'docs']);
  });
});

describe('calling', () => {
  const call = (host = createFunctionToolHost('chat'), overrides: Record<string, unknown> = {}) =>
    host.callTool({
      connectionId: '_fn',
      userId: USER,
      toolName: CONTRACT.name,
      args: { load: 1, span: 2 },
      approved: false,
      ...overrides,
    });

  it('runs through the dispatcher with its surface and returns the output, stamp, and label', async () => {
    const dispatch = vi.fn(async () => dispatched());
    const { result } = await call(createFunctionToolHost('chat', { dispatch }));

    expect(dispatch).toHaveBeenCalledWith({
      caller: { id: USER },
      functionId: '6650f0a1b2c3d4e5f6a7b8c9',
      args: { load: 1, span: 2 },
      surface: 'chat',
      approved: false,
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ output: { deflection: 0.0042 }, stamp: STAMP }) }],
      structuredContent: { deflection: 0.0042 },
      meta: STAMP,
      label: 'verified',
    });

    const agent = vi.fn(async () => dispatched());
    await call(createFunctionToolHost('agent', { dispatch: agent }));
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ surface: 'agent' }));
  });

  it('reports a dispatcher refusal as an error with its reason and problems, and no structured result', async () => {
    const problems = [{ path: 'load', message: 'must be a number' }];
    const dispatch = vi.fn(async () => dispatched({ outcome: 'input_invalid', outputs: undefined, problems }));
    const { result } = await call(createFunctionToolHost('chat', { dispatch }));
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ outcome: 'input_invalid', problems }) }],
      isError: true,
    });
  });

  it('names the field, the limit, and the length of an over-long output text', async () => {
    const problems = validateFunctionValue(
      { type: 'object', additionalProperties: false, required: [], properties: { report: { type: 'string' } } },
      { report: 'x'.repeat(4000) }
    );
    const dispatch = vi.fn(async () => dispatched({ outcome: 'output_invalid', outputs: undefined, problems }));
    const { result } = await call(createFunctionToolHost('chat', { dispatch }));
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            outcome: 'output_invalid',
            problems: [{ path: 'report', message: 'must be at most 2000 characters (it has 4000)' }],
          }),
        },
      ],
      isError: true,
    });
  });

  it('refuses a function that is no longer live without dispatching', async () => {
    const dispatch = vi.fn(async () => dispatched());
    h.bySlug = fn({ state: 'draft' });
    expect((await call(createFunctionToolHost('chat', { dispatch }))).result).toMatchObject({ isError: true });
    h.bySlug = null;
    expect((await call(createFunctionToolHost('chat', { dispatch }))).result).toMatchObject({ isError: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns a fixed error body when the dispatcher throws after writing its row', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('call log write failed at mongodb://internal');
    });
    const recordRefusal = vi.fn(async () => ({ id: 'row' }));
    const { result } = await call(createFunctionToolHost('chat', { dispatch, recordRefusal }));
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ outcome: 'error', reason: 'dispatch_failed' }) }],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain('mongodb');
    expect(recordRefusal).not.toHaveBeenCalled();
  });

  it('waits until the turn deadline less the answer reserve, and on its own cap without one', async () => {
    const dispatch = vi.fn(async () => dispatched());
    const deadline = Date.now() + 40_000;
    await call(createFunctionToolHost('chat', { dispatch }), { deadline });
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ surface: 'chat' }), {
      deadline: deadline - FUNCTION_ANSWER_RESERVE_MS,
      minWaitMs: FUNCTION_MIN_WAIT_MS,
    });
    await call(createFunctionToolHost('agent', { dispatch }));
    expect(dispatch.mock.lastCall).toHaveLength(1);
  });

  it('reads a timeout and an exhausted budget as errors with a fixed message', async () => {
    for (const [outcome, reason] of [
      ['timeout', 'wait_exceeded'],
      ['refused', 'budget_exhausted'],
    ] as const) {
      const dispatch = vi.fn(async () => dispatched({ outcome, reason, outputs: undefined, stamp: undefined }));
      const { result } = await call(createFunctionToolHost('chat', { dispatch }), { deadline: Date.now() });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content![0] as { text: string }).text);
      expect(body).toEqual({ outcome, reason, message: expect.stringMatching(/this turn/) });
    }
  });

  it('writes one refused call-log row for each refusal it makes before the dispatcher', async () => {
    const dispatch = vi.fn(async () => dispatched());
    const recordRefusal = vi.fn(async () => ({ id: 'row' }));
    const host = createFunctionToolHost('chat', { dispatch, recordRefusal });
    const caller = { id: USER };

    await call(host, { connectionId: 'docs' });
    expect(recordRefusal).toHaveBeenLastCalledWith({ caller, functionId: CONTRACT.name, surface: 'chat' }, 'not_found');
    h.bySlug = null;
    await call(host);
    expect(recordRefusal).toHaveBeenLastCalledWith(
      { caller, functionId: CONTRACT.name, surface: 'chat' },
      'not_found',
      undefined
    );
    h.bySlug = fn({ state: 'draft' });
    await call(host);
    expect(recordRefusal).toHaveBeenLastCalledWith(
      { caller, functionId: '6650f0a1b2c3d4e5f6a7b8c9', surface: 'chat' },
      'not_live',
      h.bySlug
    );
    h.bySlug = fn({ approval: 'always_ask' });
    await call(host);
    expect(recordRefusal).toHaveBeenLastCalledWith(
      { caller, functionId: '6650f0a1b2c3d4e5f6a7b8c9', surface: 'chat' },
      'approval_required',
      h.bySlug
    );
    expect(recordRefusal).toHaveBeenCalledTimes(4);
    expect(dispatch).not.toHaveBeenCalled();

    await call(host, { approved: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recordRefusal).toHaveBeenCalledTimes(4);
  });

  it("carries the record's trust label from the dispatcher's stamp to the model and the card", async () => {
    const stamp = buildCallableFunctionStamp({
      fn: {
        id: 'f',
        slug: CONTRACT.name,
        state: 'live',
        trustLabel: 'verified',
        pin: { artifactId: 'artifact-1', version: 3, contentHash: 'c0de', source: '', pinnedAt: new Date() },
      },
      inputHash: 'in',
      run: { durationMs: 5 },
      surface: 'chat',
      calledAt: new Date('2026-11-02T00:00:00Z'),
    });
    const host = createFunctionToolHost('chat', { dispatch: vi.fn(async () => dispatched({ stamp })) });
    const { result } = await call(host);
    expect(result).toMatchObject({ label: 'verified', meta: { trust_label: 'verified' } });
  });

  it('runs an always-ask function only once approved', async () => {
    const dispatch = vi.fn(async () => dispatched());
    h.bySlug = fn({ approval: 'always_ask' });
    const host = createFunctionToolHost('chat', { dispatch, recordRefusal: vi.fn(async () => ({ id: 'row' })) });
    expect((await call(host)).result.content).toEqual([
      { type: 'text', text: JSON.stringify({ outcome: 'refused', reason: 'approval_required' }) },
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    await call(host, { approved: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('chat tool generation over the offer', () => {
  it('holds an always-ask function at a card and runs a default one, wrapped with its label', async () => {
    h.offered = [fn(), fn({ slug: 'asks_first', approval: 'always_ask' })];
    h.bySlug = fn();
    const dispatch = vi.fn(async () => dispatched());
    const host = createFunctionToolHost('chat', { dispatch });
    const requestApproval = vi.fn(async () => undefined);
    const [offer] = await loadCustomMcpConnections(host, USER, logger);
    const tools = generateCustomMcpTools(offer!, { userId: USER, host, requestApproval });

    const answer = await tools.find(tool => tool.name === `_fn__${CONTRACT.name}`)!.toolFn({ load: 1, span: 2 });
    expect(answer).toContain('<untrusted_tool_result connector="_fn" host="functions" label="verified">');
    expect(answer).toContain('"stamp":{"function_id":"f"');

    await tools.find(tool => tool.name === '_fn__asks_first')!.toolFn({ load: 1, span: 2 });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: '_fn', toolName: 'asks_first' })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("passes the turn's deadline from the generated tool through to the dispatcher", async () => {
    const dispatch = vi.fn(async () => dispatched());
    const host = createFunctionToolHost('chat', { dispatch });
    const [offer] = await loadCustomMcpConnections(host, USER, logger);
    const deadline = Date.now() + 45_000;
    const [tool] = generateCustomMcpTools(offer!, { userId: USER, host, deadline });
    await tool!.toolFn({ load: 1, span: 2 });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ surface: 'chat' }), {
      deadline: deadline - FUNCTION_ANSWER_RESERVE_MS,
      minWaitMs: FUNCTION_MIN_WAIT_MS,
    });
  });
});
