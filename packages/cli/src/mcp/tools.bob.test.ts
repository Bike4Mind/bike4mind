import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// HTTP is mocked at the ApiClient (axios) layer, so the real B4mApiClient builds every request.
const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../auth/ApiClient', () => ({
  ApiClient: class {
    get = mockGet;
    post = mockPost;
    fetch = vi.fn();
  },
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
}));

import { B4mApiClient, type BobAgentRun } from './b4mApiClient';
import { buildMcpServer } from './server';
import { TOOL_META, TOOL_NAMES, registerTools, bobReadSite, bobCompareSites } from './tools';

const BASE = 'http://localhost:3000';
const RUN_ROUTE = '/api/premium-bob/bob-run';
const COMPARE_ROUTE = '/api/premium-bob/bob-compare';
const RECHECK_ROUTE = '/api/premium-bob/bob-recheck';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = '0b9b6c3e-6a4f-4d0e-9f1a-2c3d4e5f6a7b';
const COMPARISON_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REPORT = '_Bob_\n\n# acme.io\n\n| Pass | Title tag `t1.title` | ok |\n';

const axiosError = (status: number, data: unknown = {}, headers: Record<string, string> = {}) =>
  new AxiosError('request failed', undefined, {} as InternalAxiosRequestConfig, {}, {
    status,
    statusText: '',
    data,
    headers,
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

const agentRun = (runId: string, view: Partial<BobAgentRun> = {}): BobAgentRun => ({
  runId,
  url: 'acme.io',
  status: 'reading',
  progress: { done: 0, total: 3 },
  createdAt: '2026-10-21T10:00:00.000Z',
  settledAt: null,
  error: null,
  scanOnly: null,
  reportMarkdown: null,
  appPath: `/bob?run=${runId}`,
  publishedPath: null,
  visibility: null,
  ...view,
});

const OK: Partial<BobAgentRun> = {
  status: 'ok',
  progress: { done: 3, total: 3 },
  settledAt: '2026-10-21T10:03:00.000Z',
  reportMarkdown: REPORT,
  publishedPath: '/p/u/user1/bob-report',
  visibility: 'private',
};

/** Answer each run read with the next view (the last one repeats), echoing the requested id. */
function serveRuns(...views: Array<Partial<BobAgentRun>>) {
  mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
    const view = views.length > 1 ? views.shift() : views[0];
    return { ok: true, run: agentRun(config.params.id, view) };
  });
}

/** Answer each comparison read with the next pair of sides, built on the ids the start posted. */
function serveComparisons(
  ...states: Array<{ status: string; you?: Partial<BobAgentRun>; them?: Partial<BobAgentRun> }>
) {
  mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
    const body = mockPost.mock.calls[0][1] as {
      you: { runId: string; url: string };
      them: { runId: string; url: string };
    };
    const state = states.length > 1 ? states.shift()! : states[0];
    return {
      ok: true,
      comparison: {
        comparisonId: config.params.id,
        status: state.status,
        you: agentRun(body.you.runId, { url: body.you.url, ...state.you }),
        them: agentRun(body.them.runId, { url: body.them.url, ...state.them }),
        summaryMarkdown: state.status === 'ok' ? '## Who passes what\n\nacme.io leads on 4 checks.' : null,
        appPath: `/bob?compare=${config.params.id}`,
      },
    };
  });
}

type Handler = (args: unknown, extra?: unknown) => Promise<CallToolResult>;

/** Register on a fake server; `call` parses the arguments through the tool's schema, as the SDK does. */
function tools(client = new B4mApiClient(BASE, undefined, 'b4m_live_key')) {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, z.ZodRawShape>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, cb: Handler) => {
      handlers.set(name, cb);
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpServer;
  registerTools(server, client);
  const extra = { signal: new AbortController().signal, sendNotification: vi.fn() };
  return {
    schema: (name: string) => z.object(schemas.get(name)!),
    call: (name: string, args: unknown, callExtra: unknown = extra) =>
      handlers.get(name)!(z.object(schemas.get(name)!).parse(args), callExtra),
  };
}

const text = (result: CallToolResult, index = 0) => (result.content[index] as { text: string }).text;
const noSleep = { sleep: vi.fn().mockResolvedValue(undefined) };
const client = () => new B4mApiClient(BASE, undefined, 'b4m_live_key');

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ ok: true, runId: RUN_ID });
});

describe('Bob tool catalog', () => {
  const BOB_TOOLS = {
    bob_read_site: 'bob:run',
    bob_compare_sites: 'bob:run',
    bob_recheck: 'bob:run',
    get_bob_report: 'bob:read',
    get_bob_comparison: 'bob:read',
    list_bob_reports: 'bob:read',
    bob_runs_left: 'bob:read',
  };

  it('declares the seven Bob tools with their scopes', () => {
    const bob = TOOL_META.filter(t => t.name in BOB_TOOLS);
    expect(Object.fromEntries(bob.map(t => [t.name, t.scope]))).toEqual(BOB_TOOLS);
    expect(TOOL_NAMES).toHaveLength(26);
  });

  it.each(['bob_read_site', 'bob_compare_sites'])("%s says it spends the owner's credits and publishes", name => {
    const { description } = TOOL_META.find(t => t.name === name)!;
    expect(description).toContain("Spends the key owner's credits");
    expect(description).toMatch(/publishes (the|each) report/);
  });

  it('says only the two start tools spend credits, and that a re-check costs none', () => {
    const spenders = TOOL_META.filter(t => t.description.includes("Spends the key owner's credits")).map(t => t.name);
    expect(spenders).toEqual(['bob_read_site', 'bob_compare_sites']);
    const recheck = TOOL_META.find(t => t.name === 'bob_recheck')!.description;
    expect(recheck).toContain('Costs no credits');
    expect(recheck).toContain('adds the reading to the existing report');
  });

  it('lists all twenty-six tools over MCP', async () => {
    const server = buildMcpServer({ baseURL: BASE, apiKey: 'b4m_live_key', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    const { tools: listed } = await mcp.listTools();

    expect(listed.map(t => t.name)).toEqual(TOOL_NAMES);
    expect(listed.filter(t => t.name in BOB_TOOLS)).toHaveLength(7);
  });

  it('defaults waitSeconds to 600, caps it at 900 and takes null for the personal account', () => {
    const schema = tools().schema('bob_read_site');
    expect(schema.parse({ url: 'acme.io' })).toEqual({ url: 'acme.io', waitSeconds: 600 });
    expect(schema.safeParse({ url: 'acme.io', waitSeconds: 901 }).success).toBe(false);
    expect(schema.safeParse({ url: 'acme.io', waitSeconds: -1 }).success).toBe(false);
    expect(schema.parse({ url: 'acme.io', organizationId: null }).organizationId).toBeNull();
    expect(tools().schema('bob_compare_sites').parse({ yourUrl: 'a.io', theirUrl: 'b.io' })).toEqual({
      yourUrl: 'a.io',
      theirUrl: 'b.io',
      waitSeconds: 600,
      includeReports: false,
    });
  });

  it.each(['get_bob_report', 'bob_recheck'])('%s accepts only a UUID runId', name => {
    const schema = tools().schema(name);
    for (const bad of ['', 'r1', '../x', `${RUN_ID}/..`]) {
      expect(schema.safeParse({ runId: bad, checkId: 'c' }).success).toBe(false);
    }
    expect(schema.safeParse({ runId: RUN_ID, checkId: 'c' }).success).toBe(true);
  });
});

describe('bob_read_site', () => {
  it('starts the run under a fresh UUID and polls that run by its agent view', async () => {
    serveRuns({}, OK);

    await tools().call('bob_read_site', { url: 'acme.io', organizationId: 'org1', waitSeconds: 0 });

    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe(RUN_ROUTE);
    expect(body).toEqual({ url: 'acme.io', runId: expect.stringMatching(UUID_V4), organizationId: 'org1' });
    expect(mockGet).toHaveBeenCalledWith(RUN_ROUTE, { params: { id: body.runId, view: 'agent' } });
  });

  it('mints a new runId per call and leaves an omitted organizationId out of the body', async () => {
    serveRuns(OK);
    const { call } = tools();

    await call('bob_read_site', { url: 'acme.io' });
    await call('bob_read_site', { url: 'acme.io', organizationId: null });

    const [first, second] = mockPost.mock.calls.map(([, body]) => body);
    expect(first).not.toHaveProperty('organizationId');
    expect(second.organizationId).toBeNull();
    expect(second.runId).not.toBe(first.runId);
  });

  it('polls to ok and returns the summary, the report Markdown and absolute links', async () => {
    serveRuns({}, { progress: { done: 2, total: 3 } }, OK);

    const result = await bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    expect(mockGet).toHaveBeenCalledTimes(3);
    const runId = mockPost.mock.calls[0][1].runId;
    const summary = {
      runId,
      url: 'acme.io',
      status: 'ok',
      progress: { done: 3, total: 3 },
      createdAt: '2026-10-21T10:00:00.000Z',
      settledAt: '2026-10-21T10:03:00.000Z',
      error: null,
      scanOnly: null,
      appUrl: `${BASE}/bob?run=${runId}`,
      publishedUrl: `${BASE}/p/u/user1/bob-report`,
      visibility: 'private',
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(summary);
    expect(JSON.parse(text(result, 0))).toEqual(summary);
    expect(text(result, 1)).toBe(REPORT);
    expect(result.content).toHaveLength(2);
  });

  it('joins links to a base URL given with a trailing slash without doubling it', async () => {
    serveRuns(OK);

    const result = await bobReadSite(new B4mApiClient(`${BASE}/`, undefined, 'k'), { url: 'acme.io', waitSeconds: 0 });

    expect(result.structuredContent).toMatchObject({ publishedUrl: `${BASE}/p/u/user1/bob-report` });
  });

  it('fails a failed read in Bob words, naming the run', async () => {
    serveRuns({ status: 'failed', progress: null, error: 'The site did not answer.' });

    const result = await tools().call('bob_read_site', { url: 'acme.io' });

    const runId = mockPost.mock.calls[0][1].runId;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Bob could not read acme.io: The site did not answer. (run ${runId})`);
  });

  it('returns the runId, not an error, when the wait runs out', async () => {
    serveRuns({ progress: { done: 1, total: 3 } });

    const result = await tools().call('bob_read_site', { url: 'acme.io', waitSeconds: 0 });

    const runId = mockPost.mock.calls[0][1].runId;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      runId,
      status: 'reading',
      progress: { done: 1, total: 3 },
      appUrl: `${BASE}/bob?run=${runId}`,
      note: 'Bob is still reading after 0s and carries on without this call; use get_bob_report with this runId later.',
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('still returns the runId at the deadline when no poll got through', async () => {
    mockGet.mockRejectedValue(axiosError(502));

    const result = await tools().call('bob_read_site', { url: 'acme.io', waitSeconds: 0 });

    expect(result.structuredContent).toEqual({
      runId: mockPost.mock.calls[0][1].runId,
      url: 'acme.io',
      status: 'reading',
      note: expect.stringContaining('get_bob_report'),
    });
  });

  it('waits out the full waitSeconds before giving up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sleep = vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      });
      serveRuns({});

      const result = await bobReadSite(client(), { url: 'acme.io', waitSeconds: 60 }, { sleep });

      const slept = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
      expect(slept).toBe(60_000);
      expect(result.structuredContent).toMatchObject({ status: 'reading' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls at send_message's cadence: every 2s for 30s, then every 5s", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sleep = vi.fn(async (ms: number) => {
        vi.setSystemTime(Date.now() + ms);
      });
      serveRuns(...Array(17).fill({}), OK);

      await bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, { sleep });

      const waits = sleep.mock.calls.map(([ms]) => ms);
      expect(waits.slice(0, 15)).toEqual(Array(15).fill(2000));
      expect(waits.slice(15)).toEqual([5000, 5000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling through a transient failure and a 429', async () => {
    let reads = 0;
    mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
      reads += 1;
      if (reads === 1) throw axiosError(502);
      if (reads === 2) throw axiosError(429, {}, { 'retry-after': '7' });
      return { ok: true, run: agentRun(config.params.id, OK) };
    });

    const result = await bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    expect(result.structuredContent).toMatchObject({ status: 'ok' });
    expect(noSleep.sleep).toHaveBeenCalledWith(7000);
  });

  it('counts only failures in a row: a good poll between them starts the count again', async () => {
    const reads = ['fail', 'fail', 'ok', 'fail', 'fail', 'done'];
    mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
      const next = reads.shift();
      if (next === 'fail') throw axiosError(502);
      return { ok: true, run: agentRun(config.params.id, next === 'done' ? OK : {}) };
    });

    const result = await bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    expect(result.structuredContent).toMatchObject({ status: 'ok' });
    expect(mockGet).toHaveBeenCalledTimes(6);
  });

  it('fails at once when a poll is refused for good', async () => {
    mockGet.mockRejectedValue(axiosError(404, { ok: false, error: 'Run not found.' }));

    const reading = bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    await expect(reading).rejects.toThrow(/^Run not found\. \(run [0-9a-f-]{36}; the site read may still complete\)$/);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('makes no further read once the call is cancelled between polls', async () => {
    const controller = new AbortController();
    serveRuns({});
    const sleep = vi.fn(async () => controller.abort(new Error('cancelled by client')));

    const reading = bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, { sleep, signal: controller.signal });

    await expect(reading).rejects.toThrow('cancelled by client');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('gives up after three failed polls in a row, saying the read may still finish', async () => {
    mockGet.mockRejectedValue(axiosError(502, { error: 'Bad gateway' }));

    const reading = bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    await expect(reading).rejects.toThrow(/^Bad gateway \(run [0-9a-f-]{36}; the site read may still complete\)$/);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('gives up on a server that answers without the agent view', async () => {
    mockGet.mockResolvedValue({ ok: true, run: { _id: RUN_ID, status: 'reading', url: 'acme.io' } });

    const reading = bobReadSite(client(), { url: 'acme.io', waitSeconds: 600 }, noSleep);

    await expect(reading).rejects.toThrow(
      `the Bike4Mind server at ${BASE} answered the Bob run without its agent view; it likely predates these tools`
    );
  });

  it("returns a 200 refusal as an error in Bob's own words and polls nothing", async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'Not enough credits for a full read.', reason: 'credits' });

    const result = await tools().call('bob_read_site', { url: 'acme.io' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'Not enough credits for a full read.' }], isError: true });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('names bob:run when the key is missing it', async () => {
    mockPost.mockRejectedValue(
      axiosError(403, { ok: false, error: 'API key is missing the bob:run scope', code: 'missing_scope' })
    );

    const result = await tools().call('bob_read_site', { url: 'acme.io' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('API key is missing the bob:run scope (grant the key bob:run)');
  });

  it('surfaces a 503 start refusal in Bob words', async () => {
    mockPost.mockRejectedValue(axiosError(503, { ok: false, error: 'Bob could not start the run. Please try again.' }));

    const result = await tools().call('bob_read_site', { url: 'acme.io' });

    expect(text(result)).toBe('Bob could not start the run. Please try again.');
  });

  it('says so when the server has no Bob', async () => {
    mockPost.mockRejectedValue(axiosError(404, '<html>Not found</html>'));

    const result = await tools().call('bob_read_site', { url: 'acme.io' });

    expect(text(result)).toBe(`Bob is not available on the Bike4Mind server at ${BASE}`);
  });

  describe('progress and cancellation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("reports on every poll, with rising progress and Bob's done and total in the message", async () => {
      // No count, then an empty one (a read with no personas to count), then the real count.
      serveRuns(
        { progress: null },
        { progress: { done: 0, total: 0 } },
        { progress: { done: 0, total: 3 } },
        {},
        { progress: { done: 2, total: 3 } },
        OK
      );
      const sendNotification = vi.fn().mockResolvedValue(undefined);

      const pending = tools().call(
        'bob_read_site',
        { url: 'acme.io' },
        { signal: new AbortController().signal, sendNotification, _meta: { progressToken: 'tok' } }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      const sent = sendNotification.mock.calls.map(([n]) => n);
      expect(sent.map(n => n.params.message)).toEqual([
        'reading acme.io',
        'reading acme.io',
        'reading acme.io (0 of 3)',
        'reading acme.io (0 of 3)',
        'reading acme.io (2 of 3)',
      ]);
      // MCP requires progress to rise on every notification, even while Bob's count stays flat.
      expect(sent.map(n => n.params.progress)).toEqual([0, 2, 4, 6, 8]);
      expect(sent[0]).toEqual({
        method: 'notifications/progress',
        params: { progressToken: 'tok', progress: 0, message: 'reading acme.io' },
      });
      expect(result.structuredContent).toMatchObject({ status: 'ok' });
    });

    it('sends no notification without a progress token', async () => {
      serveRuns({}, OK);
      const sendNotification = vi.fn();

      const pending = tools().call(
        'bob_read_site',
        { url: 'acme.io' },
        { signal: new AbortController().signal, sendNotification }
      );
      await vi.runAllTimersAsync();
      await pending;

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('stops polling and returns isError when the client cancels mid-poll', async () => {
      const controller = new AbortController();
      mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
        controller.abort(new Error('cancelled by client'));
        return { ok: true, run: agentRun(config.params.id) };
      });
      const sendNotification = vi.fn();

      const pending = tools().call(
        'bob_read_site',
        { url: 'acme.io' },
        { signal: controller.signal, sendNotification, _meta: { progressToken: 'tok' } }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(text(result)).toBe('cancelled by client');
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(sendNotification).not.toHaveBeenCalled();
    });
  });
});

describe('bob_compare_sites', () => {
  beforeEach(() => mockPost.mockResolvedValue({ ok: true }));

  it('starts one comparison under three distinct UUIDs and polls its agent view', async () => {
    serveComparisons({ status: 'ok', you: OK, them: OK });

    await tools().call('bob_compare_sites', { yourUrl: 'acme.io', theirUrl: 'rival.io', organizationId: null });

    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe(COMPARE_ROUTE);
    expect(body).toEqual({
      comparisonId: expect.stringMatching(UUID_V4),
      you: { url: 'acme.io', runId: expect.stringMatching(UUID_V4) },
      them: { url: 'rival.io', runId: expect.stringMatching(UUID_V4) },
      organizationId: null,
    });
    expect(new Set([body.comparisonId, body.you.runId, body.them.runId]).size).toBe(3);
    expect(mockGet).toHaveBeenCalledWith(COMPARE_ROUTE, { params: { id: body.comparisonId, view: 'agent' } });
  });

  it("polls to ok and returns the summary Markdown with each side's status and links", async () => {
    serveComparisons(
      { status: 'reading' },
      { status: 'ok', you: OK, them: { ...OK, publishedPath: null, visibility: null } }
    );

    const result = await bobCompareSites(
      client(),
      { yourUrl: 'acme.io', theirUrl: 'rival.io', waitSeconds: 600 },
      noSleep
    );

    const body = mockPost.mock.calls[0][1];
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      comparisonId: body.comparisonId,
      status: 'ok',
      appUrl: `${BASE}/bob?compare=${body.comparisonId}`,
      you: { runId: body.you.runId, url: 'acme.io', status: 'ok', publishedUrl: `${BASE}/p/u/user1/bob-report` },
      them: { runId: body.them.runId, url: 'rival.io', status: 'ok', publishedUrl: null },
    });
    expect(text(result, 1)).toBe('## Who passes what\n\nacme.io leads on 4 checks.');
    expect(result.content).toHaveLength(2);
  });

  it("adds each side's report when includeReports is set", async () => {
    serveComparisons({ status: 'ok', you: OK, them: OK });

    const result = await tools().call('bob_compare_sites', {
      yourUrl: 'acme.io',
      theirUrl: 'rival.io',
      includeReports: true,
    });

    expect(result.content.slice(2).map(c => (c as { text: string }).text)).toEqual([
      `Report for acme.io:\n\n${REPORT}`,
      `Report for rival.io:\n\n${REPORT}`,
    ]);
  });

  it('returns a comparison with one failed side as a result, carrying that side error', async () => {
    serveComparisons({ status: 'ok', you: OK, them: { status: 'failed', error: 'The site blocked the read.' } });

    const result = await tools().call('bob_compare_sites', { yourUrl: 'acme.io', theirUrl: 'rival.io' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ them: { status: 'failed', error: 'The site blocked the read.' } });
  });

  it('fails when neither side could be read, giving both reasons', async () => {
    serveComparisons({
      status: 'failed',
      you: { status: 'failed', error: 'Timed out.' },
      them: { status: 'failed', error: 'Blocked.' },
    });

    const result = await tools().call('bob_compare_sites', { yourUrl: 'acme.io', theirUrl: 'rival.io' });

    const { comparisonId } = mockPost.mock.calls[0][1];
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `Bob could not read either site: acme.io: Timed out.; rival.io: Blocked. (comparison ${comparisonId})`
    );
  });

  it('names one side with no run when a failed comparison is missing it', async () => {
    mockGet.mockImplementation(async (_url: string, config: { params: { id: string } }) => {
      const { you } = mockPost.mock.calls[0][1];
      return {
        ok: true,
        comparison: {
          comparisonId: config.params.id,
          status: 'failed',
          you: agentRun(you.runId, { url: 'acme.io', status: 'failed', error: 'Timed out.' }),
          them: null,
          summaryMarkdown: null,
          appPath: `/bob?compare=${config.params.id}`,
        },
      };
    });

    const result = await tools().call('bob_compare_sites', { yourUrl: 'acme.io', theirUrl: 'rival.io' });

    expect(text(result)).toMatch(
      /^Bob could not read either site: acme\.io: Timed out\.; one side has no run \(comparison /
    );
  });

  it('still returns both ids at the deadline when no poll got through', async () => {
    mockGet.mockRejectedValue(axiosError(502));

    const result = await tools().call('bob_compare_sites', {
      yourUrl: 'acme.io',
      theirUrl: 'rival.io',
      waitSeconds: 0,
    });

    const body = mockPost.mock.calls[0][1];
    expect(result.structuredContent).toEqual({
      comparisonId: body.comparisonId,
      status: 'reading',
      you: { url: 'acme.io', runId: body.you.runId },
      them: { url: 'rival.io', runId: body.them.runId },
      note: expect.stringContaining('get_bob_comparison'),
    });
  });

  it('returns the comparisonId when the wait runs out', async () => {
    serveComparisons({ status: 'reading' });

    const result = await tools().call('bob_compare_sites', {
      yourUrl: 'acme.io',
      theirUrl: 'rival.io',
      waitSeconds: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      comparisonId: mockPost.mock.calls[0][1].comparisonId,
      status: 'reading',
      note: expect.stringContaining('get_bob_comparison with this comparisonId'),
    });
  });

  it("returns a 200 refusal as an error in Bob's own words", async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'A comparison needs 2 runs and you have 1 left today.' });

    const result = await tools().call('bob_compare_sites', { yourUrl: 'acme.io', theirUrl: 'rival.io' });

    expect(text(result)).toBe('A comparison needs 2 runs and you have 1 left today.');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports the summed progress of both sides', async () => {
    vi.useFakeTimers();
    try {
      serveComparisons(
        { status: 'reading', you: { progress: { done: 1, total: 3 } }, them: { progress: { done: 0, total: 3 } } },
        { status: 'ok', you: OK, them: OK }
      );
      const sendNotification = vi.fn().mockResolvedValue(undefined);

      const pending = tools().call(
        'bob_compare_sites',
        { yourUrl: 'acme.io', theirUrl: 'rival.io' },
        { signal: new AbortController().signal, sendNotification, _meta: { progressToken: 7 } }
      );
      await vi.runAllTimersAsync();
      await pending;

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith({
        method: 'notifications/progress',
        params: { progressToken: 7, progress: 0, message: 'reading both sites (1 of 6)' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bob_recheck', () => {
  const recheck = { checkId: 't1.title', at: '2026-10-21T11:00:00.000Z', was: 'fail', state: 'pass', value: 'Acme' };

  it('posts the run and check and returns the new reading', async () => {
    mockPost.mockResolvedValue({ ok: true, recheck });

    const result = await tools().call('bob_recheck', { runId: RUN_ID, checkId: 't1.title' });

    expect(mockPost).toHaveBeenCalledWith(RECHECK_ROUTE, { runId: RUN_ID, checkId: 't1.title' });
    expect(result.structuredContent).toEqual({ runId: RUN_ID, recheck });
  });

  it.each([
    [
      429,
      {
        ok: false,
        error: 'Re-check limit: this check was re-checked moments ago; try again in 12s.',
        retryAfterMs: 11_200,
      },
      12,
    ],
    [503, { ok: false, error: 'Re-check not run: Bob is paused. Nothing was saved.', retryAfterMs: 61_000 }, 61],
  ])('reports a %s with the wait it carries', async (status, body, seconds) => {
    mockPost.mockRejectedValue(axiosError(status, body));

    const result = await tools().call('bob_recheck', { runId: RUN_ID, checkId: 't1.title' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`${body.error} (retry after ${seconds}s)`);
  });

  it('gives Bob words alone when no retry would pass', async () => {
    const error = 'Re-check limit: this run already holds 50 re-checks; start a new run to read the site again.';
    mockPost.mockRejectedValue(axiosError(429, { ok: false, error, retryAfterMs: null }));

    const result = await tools().call('bob_recheck', { runId: RUN_ID, checkId: 't1.title' });

    expect(text(result)).toBe(error);
  });

  it('surfaces a 409 in Bob words', async () => {
    const error = 'This run has no machine read to re-check. Start a new run instead.';
    mockPost.mockRejectedValue(axiosError(409, { ok: false, error }));

    expect(text(await tools().call('bob_recheck', { runId: RUN_ID, checkId: 't1.title' }))).toBe(error);
  });
});

describe('Bob read-back tools', () => {
  it('get_bob_report makes one agent-view read and returns the report', async () => {
    serveRuns(OK);

    const result = await tools().call('get_bob_report', { runId: RUN_ID });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(RUN_ROUTE, { params: { id: RUN_ID, view: 'agent' } });
    expect(result.structuredContent).toMatchObject({
      runId: RUN_ID,
      status: 'ok',
      appUrl: `${BASE}/bob?run=${RUN_ID}`,
    });
    expect(text(result, 1)).toBe(REPORT);
  });

  it('get_bob_report returns a run still reading, with its progress and no report', async () => {
    serveRuns({ progress: { done: 1, total: 3 } });

    const result = await tools().call('get_bob_report', { runId: RUN_ID });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: 'reading', progress: { done: 1, total: 3 } });
    expect(result.content).toHaveLength(1);
  });

  it.each([
    [
      { ok: false, error: 'API key is missing the bob:read scope', code: 'missing_scope' },
      'API key is missing the bob:read scope',
    ],
    [
      { error: 'Insufficient API key permissions', required_scopes: ['bob:read', 'bob:run', 'admin:*'] },
      'Insufficient API key permissions',
    ],
  ])('get_bob_report names bob:read on a scope 403 (%o)', async (body, message) => {
    mockGet.mockRejectedValue(axiosError(403, body));

    const result = await tools().call('get_bob_report', { runId: RUN_ID });

    expect(text(result)).toBe(`${message} (grant the key bob:read)`);
  });

  it("get_bob_report surfaces another user's or a missing run as not found", async () => {
    mockGet.mockRejectedValue(axiosError(404, { ok: false, error: 'Run not found.' }));

    expect(text(await tools().call('get_bob_report', { runId: RUN_ID }))).toBe('Run not found.');
  });

  it("get_bob_comparison makes one read and returns the summary and each side's links", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      comparison: {
        comparisonId: COMPARISON_ID,
        status: 'ok',
        you: agentRun(RUN_ID, OK),
        them: null,
        summaryMarkdown: '## Who passes what',
        appPath: `/bob?compare=${COMPARISON_ID}`,
      },
    });

    const result = await tools().call('get_bob_comparison', { comparisonId: COMPARISON_ID });

    expect(mockGet).toHaveBeenCalledWith(COMPARE_ROUTE, { params: { id: COMPARISON_ID, view: 'agent' } });
    expect(result.structuredContent).toMatchObject({
      comparisonId: COMPARISON_ID,
      you: { runId: RUN_ID, appUrl: `${BASE}/bob?run=${RUN_ID}` },
      them: null,
      appUrl: `${BASE}/bob?compare=${COMPARISON_ID}`,
    });
    expect(result.content.map(c => (c as { text: string }).text).slice(1)).toEqual(['## Who passes what']);
  });

  const AT = '2026-10-21T10:00:00.000Z';
  const RUN_ROW = { kind: 'run', runId: RUN_ID, url: 'acme.io', createdAt: AT };
  const COMPARISON_ROW = {
    kind: 'comparison',
    comparisonId: COMPARISON_ID,
    you: 'acme.io',
    them: 'rival.io',
    createdAt: AT,
  };
  const RUN_REPORT = { kind: 'run', runId: RUN_ID, url: 'acme.io', createdAt: AT, appUrl: `${BASE}/bob?run=${RUN_ID}` };
  const COMPARISON_REPORT = {
    kind: 'comparison',
    comparisonId: COMPARISON_ID,
    you: 'acme.io',
    them: 'rival.io',
    createdAt: AT,
    appUrl: `${BASE}/bob?compare=${COMPARISON_ID}`,
  };

  it('list_bob_reports asks for the recent list and passes a run row through compact', async () => {
    mockGet.mockResolvedValue({ ok: true, runs: [{ ...RUN_ROW, extra: 'dropped' }] });

    const result = await tools().call('list_bob_reports', { limit: 5 });

    expect(mockGet).toHaveBeenCalledWith(RUN_ROUTE, { params: { list: 'recent', limit: 5 } });
    expect(result.structuredContent).toEqual({ reports: [RUN_REPORT] });
  });

  it('list_bob_reports passes a comparison row through with its own link, in list order', async () => {
    mockGet.mockResolvedValue({ ok: true, runs: [{ ...COMPARISON_ROW, extra: 'dropped' }, RUN_ROW] });

    const result = await tools().call('list_bob_reports', {});

    expect(result.structuredContent).toEqual({ reports: [COMPARISON_REPORT, RUN_REPORT] });
  });

  it('list_bob_reports reads a row with no kind, from a server that predates comparisons, as a run', async () => {
    mockGet.mockResolvedValue({ ok: true, runs: [{ runId: RUN_ID, url: 'acme.io', createdAt: AT }] });

    const result = await tools().call('list_bob_reports', {});

    expect(result.structuredContent).toEqual({ reports: [RUN_REPORT] });
  });

  it('list_bob_reports drops a row of a kind it does not know and keeps the rest', async () => {
    mockGet.mockResolvedValue({
      ok: true,
      runs: [
        { kind: 'folder', folderId: 'f1', createdAt: AT },
        COMPARISON_ROW,
        { kind: 'run', url: 'no-id.io' },
        RUN_ROW,
      ],
    });

    const result = await tools().call('list_bob_reports', {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ reports: [COMPARISON_REPORT, RUN_REPORT] });
  });

  it('list_bob_reports says which tool reads each kind of row', () => {
    const { description } = TOOL_META.find(t => t.name === 'list_bob_reports')!;
    expect(description).toContain("comparisons (kind 'comparison')");
    expect(description).toContain('get_bob_report');
    expect(description).toContain('get_bob_comparison');
  });

  it('list_bob_reports leaves the limit to the server when omitted', async () => {
    mockGet.mockResolvedValue({ ok: true, runs: [] });

    await tools().call('list_bob_reports', {});

    expect(mockGet).toHaveBeenCalledWith(RUN_ROUTE, { params: { list: 'recent' } });
  });

  it.each([
    [{}, { quota: '' }],
    [{ organizationId: null }, { quota: '', organizationId: '' }],
    [{ organizationId: 'org1' }, { quota: '', organizationId: 'org1' }],
  ])('bob_runs_left with %o asks for the quota with %o', async (args, params) => {
    const quota = { limit: 10, left: 7, nextSlotAt: '2026-10-22T09:00:00.000Z', lowCredits: false };
    mockGet.mockResolvedValue({ ok: true, quota });

    const result = await tools().call('bob_runs_left', args);

    expect(mockGet).toHaveBeenCalledWith(RUN_ROUTE, { params });
    expect(result.structuredContent).toEqual(quota);
  });
});
