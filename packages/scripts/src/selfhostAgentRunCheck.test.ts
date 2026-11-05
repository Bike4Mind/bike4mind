import { describe, expect, it } from 'vitest';
import { ACTIVE_AGENT_EXECUTION_STATUSES } from '@bike4mind/common';
import { runSelfhostAgentCheck, type AgentRunCheckConfig } from './selfhostAgentRunCheck';

const NONCE = 'nonce-test-123';
const API_KEY = 'b4m_live_secretvalue';
const EXEC_ID = 'exec-1';

type Poll = Record<string, unknown> | { httpStatus: number; body?: unknown } | { throws: string };

interface Recorded {
  method?: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const hang = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason));
  });

function setup(opts: {
  polls: Poll[];
  start?: Response;
  session?: Response;
  execId?: string;
  hang?: 'session' | 'poll';
  /** Fake-clock ms the session create takes. */
  sessionTakesMs?: number;
  config?: Partial<AgentRunCheckConfig>;
}) {
  const polls = [...opts.polls];
  const execId = opts.execId ?? EXEC_ID;
  const requests: Recorded[] = [];
  const signalMs: number[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let calls = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    // A retry branch that loses its sleep would spin on microtasks and starve vitest's timeout.
    // Aborting (not a plain throw, which the poll loop retries) ends the run so the test fails by name.
    if (++calls > 50) throw new DOMException('stub: too many requests', 'TimeoutError');
    const path = new URL(url).pathname;
    requests.push({
      method: init?.method,
      path,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (opts.hang === 'session' && path === '/api/v1/sessions') return hang(init?.signal);
    if (path === '/api/v1/sessions') clock += opts.sessionTakesMs ?? 0;
    if (path === '/api/v1/sessions') return opts.session ?? json(201, { id: 'sess-1' });
    if (path === '/api/v1/agent-executions') return opts.start ?? json(202, { id: execId });
    if (opts.hang === 'poll') return hang(init?.signal);
    const next = polls.length > 1 ? polls.shift()! : polls[0];
    if ('throws' in next) throw new Error(next.throws);
    if ('httpStatus' in next) return json(next.httpStatus, next.body ?? { error: 'rate limited' });
    return json(200, { id: execId, ...next });
  }) as unknown as typeof fetch;
  const run = () =>
    runSelfhostAgentCheck(
      {
        fetch: fakeFetch,
        sleep: async ms => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
        timeoutSignal: ms => {
          signalMs.push(ms);
          return opts.hang
            ? AbortSignal.abort(new DOMException('timed out', 'TimeoutError'))
            : new AbortController().signal;
        },
      },
      {
        baseUrl: 'http://self.host',
        apiKey: API_KEY,
        nonce: NONCE,
        timeoutMs: 10_000,
        pollIntervalMs: 1_000,
        ...opts.config,
      }
    );
  const gets = () => requests.filter(r => r.method === 'GET');
  return { run, requests, gets, signalMs, sleeps };
}

describe('runSelfhostAgentCheck', () => {
  it('passes a completed run whose answer contains the nonce', async () => {
    const { run } = setup({
      polls: [
        { status: 'pending' },
        { status: 'running' },
        { status: 'completed', answer: NONCE, total_iterations: 1 },
      ],
    });
    expect(await run()).toEqual({ ok: true, executionId: EXEC_ID, iterations: 1 });
  });

  it('sends the key on every call, the nonce in the prompt, and polls the encoded id', async () => {
    const { run, requests } = setup({
      execId: 'exec/1',
      polls: [{ status: 'completed', answer: NONCE }],
    });
    expect((await run()).ok).toBe(true);
    expect(requests).toHaveLength(3);
    for (const r of requests) expect(r.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const start = requests[1];
    expect(start.body?.session_id).toBe('sess-1');
    expect(start.body?.message).toContain(NONCE);
    expect(requests[2].path).toBe('/api/v1/agent-executions/exec%2F1');
    expect('model' in (start.body ?? {})).toBe(false);
  });

  it('passes the configured model to the start request', async () => {
    const { run, requests } = setup({
      polls: [{ status: 'completed', answer: NONCE }],
      config: { model: 'm-1' },
    });
    expect((await run()).ok).toBe(true);
    expect(requests[1].body?.model).toBe('m-1');
  });

  it('fails a failed run and quotes its error', async () => {
    const { run } = setup({ polls: [{ status: 'failed', answer: null, error: 'model error' }] });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: `run ${EXEC_ID} ended failed: model error`,
    });
  });

  it('fails a failed run even when its answer contains the nonce', async () => {
    const { run } = setup({ polls: [{ status: 'failed', answer: NONCE, error: 'boom' }] });
    expect(await run()).toEqual({ ok: false, executionId: EXEC_ID, reason: `run ${EXEC_ID} ended failed: boom` });
  });

  it('fails an aborted run', async () => {
    const { run } = setup({ polls: [{ status: 'aborted', answer: null }] });
    expect(await run()).toEqual({ ok: false, executionId: EXEC_ID, reason: `run ${EXEC_ID} ended aborted` });
  });

  it('fails a completed run whose answer lacks the nonce', async () => {
    const { run } = setup({ polls: [{ status: 'completed', answer: 'Sorry, something went wrong' }] });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: `run ${EXEC_ID} completed but answer lacks expected token`,
    });
  });

  it('fails a completed run with a null answer without throwing', async () => {
    const { run } = setup({ polls: [{ status: 'completed', answer: null }] });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: `run ${EXEC_ID} completed but answer lacks expected token`,
    });
  });

  it('fails when the polled id differs from the started id', async () => {
    const { run } = setup({ polls: [{ id: 'other', status: 'completed', answer: NONCE }] });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: `polled execution id other does not match started ${EXEC_ID}`,
    });
  });

  it('fails an unknown status at once, with one GET', async () => {
    const { run, gets } = setup({ polls: [{ status: 'weird', answer: NONCE }] });
    expect(await run()).toEqual({ ok: false, executionId: EXEC_ID, reason: `run ${EXEC_ID} ended weird` });
    expect(gets()).toHaveLength(1);
  });

  it('times out when the run never leaves an active status', async () => {
    const { run, gets } = setup({ polls: [{ status: 'running' }], config: { timeoutMs: 3_000 } });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: 'timed out after 3s; last status running',
    });
    expect(gets()).toHaveLength(3);
  });

  it.each(ACTIVE_AGENT_EXECUTION_STATUSES)('keeps polling while status is %s', async status => {
    const { run } = setup({ polls: [{ status }, { status: 'completed', answer: NONCE }] });
    expect((await run()).ok).toBe(true);
  });

  it('fails at start without polling when start is not 202', async () => {
    const { run, gets } = setup({ polls: [], start: json(400, { error: 'no model configured' }) });
    expect(await run()).toEqual({ ok: false, reason: 'start HTTP 400: no model configured' });
    expect(gets()).toHaveLength(0);
  });

  it('backs off on 429 while polling, then succeeds', async () => {
    const { run, sleeps } = setup({ polls: [{ httpStatus: 429 }, { status: 'completed', answer: NONCE }] });
    expect((await run()).ok).toBe(true);
    expect(sleeps).toEqual([1_000]);
  });

  it('times out with a bounded GET count when every poll is 429', async () => {
    const { run, gets } = setup({ polls: [{ httpStatus: 429 }], config: { timeoutMs: 3_000 } });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: 'timed out after 3s; no status observed; last error HTTP 429',
    });
    expect(gets()).toHaveLength(3);
  });

  it.each([502, 503, 504])('retries a %i poll, then succeeds', async status => {
    const { run, sleeps } = setup({
      polls: [
        { httpStatus: status, body: { error: 'upstream' } },
        { status: 'completed', answer: NONCE },
      ],
    });
    expect((await run()).ok).toBe(true);
    expect(sleeps).toEqual([1_000]);
  });

  it('retries a thrown poll error, then succeeds', async () => {
    const { run } = setup({ polls: [{ throws: 'fetch failed' }, { status: 'completed', answer: NONCE }] });
    expect((await run()).ok).toBe(true);
  });

  it('keeps the execution id when polls keep throwing until the deadline', async () => {
    const { run, gets, sleeps } = setup({ polls: [{ throws: 'fetch failed' }], config: { timeoutMs: 2_000 } });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: 'timed out after 2s; no status observed; last error fetch failed',
    });
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(gets()).toHaveLength(2);
  });

  it('fails on other non-2xx while polling, with the execution id', async () => {
    const { run } = setup({ polls: [{ httpStatus: 404, body: { error: 'Execution not found' } }] });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: 'poll HTTP 404: Execution not found',
    });
  });

  it('bounds every request by the time left on the deadline', async () => {
    const { run, signalMs } = setup({
      polls: [{ status: 'running' }, { status: 'completed', answer: NONCE }],
      config: { timeoutMs: 10_000 },
    });
    await run();
    expect(signalMs).toEqual([10_000, 10_000, 10_000, 9_000]);
  });

  it('counts time spent in session create against the same deadline', async () => {
    const { run, signalMs } = setup({
      polls: [{ status: 'completed', answer: NONCE }],
      sessionTakesMs: 4_000,
    });
    await run();
    expect(signalMs).toEqual([10_000, 6_000, 6_000]);
  });

  it('times out a stalled session create instead of hanging', async () => {
    const { run } = setup({ polls: [], hang: 'session', config: { timeoutMs: 4_000 } });
    expect(await run()).toEqual({
      ok: false,
      executionId: undefined,
      reason: 'timed out after 4s; no status observed',
    });
  });

  it('times out a stalled poll and keeps the execution id', async () => {
    const { run } = setup({ polls: [], hang: 'poll', config: { timeoutMs: 4_000 } });
    expect(await run()).toEqual({
      ok: false,
      executionId: EXEC_ID,
      reason: 'timed out after 4s; no status observed',
    });
  });

  it('never leaks the API key into a failure reason', async () => {
    const cases = [
      setup({ polls: [], session: json(401, { error: 'bad key' }) }),
      setup({ polls: [], start: json(500, { error: 'x' }) }),
      setup({ polls: [{ status: 'failed', error: 'x' }] }),
      setup({ polls: [{ status: 'running' }], config: { timeoutMs: 2_000 } }),
    ];
    for (const c of cases) {
      const r = await c.run();
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(API_KEY);
    }
  });
});
