import { describe, expect, it } from 'vitest';
import { ACTIVE_AGENT_EXECUTION_STATUSES } from '@bike4mind/common';
import { runSelfhostAgentCheck, type AgentRunCheckConfig } from './selfhostAgentRunCheck';

const NONCE = 'nonce-test-123';
const API_KEY = 'b4m_live_secretvalue';
const EXEC_ID = 'exec-1';

type Poll = Record<string, unknown> | { httpStatus: number; body?: unknown };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(opts: { polls: Poll[]; start?: Response; session?: Response; config?: Partial<AgentRunCheckConfig> }) {
  const polls = [...opts.polls];
  const calls: string[] = [];
  let clock = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === '/api/v1/sessions') return opts.session ?? json(201, { id: 'sess-1' });
    if (path === '/api/v1/agent-executions') return opts.start ?? json(202, { id: EXEC_ID });
    const next = polls.length > 1 ? polls.shift()! : polls[0];
    if ('httpStatus' in next) return json(next.httpStatus, next.body ?? { error: 'rate limited' });
    return json(200, { id: EXEC_ID, ...next });
  }) as unknown as typeof fetch;
  const run = () =>
    runSelfhostAgentCheck(
      {
        fetch: fakeFetch,
        sleep: async ms => {
          clock += ms;
        },
        now: () => clock,
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
  return { run, calls };
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

  it('fails a failed run and quotes its error', async () => {
    const { run } = setup({ polls: [{ status: 'failed', answer: null, error: 'model error' }] });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/failed.*model error/);
  });

  it('fails a failed run even when its answer contains the nonce', async () => {
    const { run } = setup({ polls: [{ status: 'failed', answer: NONCE, error: 'boom' }] });
    expect((await run()).ok).toBe(false);
  });

  it('fails an aborted run', async () => {
    const { run } = setup({ polls: [{ status: 'aborted', answer: null }] });
    const r = await run();
    expect(!r.ok && r.reason).toMatch(/aborted/);
  });

  it('fails a completed run whose answer lacks the nonce', async () => {
    const { run } = setup({ polls: [{ status: 'completed', answer: 'Sorry, something went wrong' }] });
    const r = await run();
    expect(!r.ok && r.reason).toMatch(/lacks expected token/);
  });

  it('fails a completed run with a null answer', async () => {
    const { run } = setup({ polls: [{ status: 'completed', answer: null }] });
    expect((await run()).ok).toBe(false);
  });

  it('fails when the polled id differs from the started id', async () => {
    const { run } = setup({ polls: [{ id: 'other', status: 'completed', answer: NONCE }] });
    const r = await run();
    expect(!r.ok && r.reason).toMatch(/does not match/);
  });

  it('fails an unknown status', async () => {
    const { run } = setup({ polls: [{ status: 'weird', answer: NONCE }] });
    expect((await run()).ok).toBe(false);
  });

  it('times out when the run never leaves an active status', async () => {
    const { run, calls } = setup({ polls: [{ status: 'running' }], config: { timeoutMs: 3_000 } });
    const r = await run();
    expect(!r.ok && r.reason).toMatch(/timed out after 3s; last status running/);
    expect(calls.filter(c => c.startsWith('GET'))).toHaveLength(3);
  });

  it.each(ACTIVE_AGENT_EXECUTION_STATUSES)('keeps polling while status is %s', async status => {
    const { run } = setup({ polls: [{ status }, { status: 'completed', answer: NONCE }] });
    expect((await run()).ok).toBe(true);
  });

  it('fails at start without polling when start is not 202', async () => {
    const { run, calls } = setup({ polls: [], start: json(400, { error: 'no model configured' }) });
    const r = await run();
    expect(!r.ok && r.reason).toBe('start HTTP 400: no model configured');
    expect(calls.some(c => c.startsWith('GET'))).toBe(false);
  });

  it('backs off on 429 while polling, then succeeds', async () => {
    const { run } = setup({ polls: [{ httpStatus: 429 }, { status: 'completed', answer: NONCE }] });
    expect((await run()).ok).toBe(true);
  });

  it('fails on other non-2xx while polling', async () => {
    const { run } = setup({ polls: [{ httpStatus: 404, body: { error: 'Execution not found' } }] });
    const r = await run();
    expect(!r.ok && r.reason).toMatch(/poll HTTP 404: Execution not found/);
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
