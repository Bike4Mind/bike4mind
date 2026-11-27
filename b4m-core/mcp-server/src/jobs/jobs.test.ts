import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, makeCtx, mockTransport } from '../testUtils';
import { stopJob, waitForJob } from './tools';

const ID = '0123456789abcdef01234567';
const JOB = `confirmation:${ID}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const run = (tool: typeof waitForJob, args: Record<string, unknown>, ctx = makeCtx()) =>
  tool.handler({ max_wait_seconds: 20, ...args }, ctx);

describe('wait_for_job', () => {
  it('returns once a pending job becomes done', async () => {
    const transport = mockTransport();
    transport.call
      .mockResolvedValueOnce(json(200, { status: 'pending' }))
      .mockResolvedValueOnce(json(200, { status: 'approved' }));
    const p = run(waitForJob, { jobs: [JOB] }, makeCtx({ transport }));
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { jobs: [{ job: JOB, state: 'done' }] } });
    expect(transport.call).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['http', 25],
    ['stdio', 900],
  ] as const)('clamps the wait on %s to %i seconds', async (kind, budget) => {
    const transport = mockTransport(async () => json(200, { status: 'pending' }));
    const start = Date.now();
    const p = run(
      waitForJob,
      { jobs: [JOB], max_wait_seconds: 900 },
      makeCtx({ transport, kind, waitBudgetSeconds: 5000 })
    );
    await vi.advanceTimersByTimeAsync(budget * 1000 + 10_000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'pending' });
    // the loop ended at the kind's cap, not at the 5000 s the host asked for
    expect(Date.now() - start).toBeLessThanOrEqual(budget * 1000 + 10_000);
    const polls = transport.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.call.mock.calls.length).toBe(polls);
  });

  it('honours a smaller ctx.waitBudgetSeconds', async () => {
    const transport = mockTransport(async () => json(200, { status: 'pending' }));
    const p = run(waitForJob, { jobs: [JOB], max_wait_seconds: 900 }, makeCtx({ transport, waitBudgetSeconds: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(transport.call.mock.calls.length).toBeLessThanOrEqual(3);
    const polls = transport.call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.call.mock.calls.length).toBe(polls);
  });

  it.each([NaN, 0, -5, Infinity])('falls back to the kind cap for a host budget of %s', async budget => {
    const transport = mockTransport(async () => json(200, { status: 'pending' }));
    const p = run(
      waitForJob,
      { jobs: [JOB], max_wait_seconds: 900 },
      makeCtx({ transport, kind: 'http', waitBudgetSeconds: budget })
    );
    await vi.advanceTimersByTimeAsync(25_000 + 10_000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'pending' });
    // about 12 polls in 25 s with backoff, not one per millisecond
    expect(transport.call.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(transport.call.mock.calls.length).toBeLessThan(30);
  });

  it('keeps the job pending through a transient poll error', async () => {
    const transport = mockTransport();
    transport.call
      .mockResolvedValueOnce(json(503, {}))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, { status: 'approved' }));
    const p = run(waitForJob, { jobs: [JOB] }, makeCtx({ transport }));
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { jobs: [{ job: JOB, state: 'done' }] } });
    expect(transport.call).toHaveBeenCalledTimes(4);
  });

  it('reports the last transient error when the budget ends', async () => {
    const transport = mockTransport(async () => json(503, {}));
    const p = run(waitForJob, { jobs: [JOB], max_wait_seconds: 3 }, makeCtx({ transport }));
    await vi.advanceTimersByTimeAsync(4000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({
      status: 'pending',
      result: { jobs: [{ state: 'pending', error: expect.stringMatching(/503/) }] },
    });
  });

  it('returns pending at the budget when a poll never settles, and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const transport = mockTransport(async (_op, req) => {
      signal = req?.signal;
      return new Promise(() => {});
    });
    const p = run(waitForJob, { jobs: [JOB], max_wait_seconds: 3 }, makeCtx({ transport }));
    await vi.advanceTimersByTimeAsync(3000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'pending' });
    expect(signal?.aborted).toBe(true);
  });

  it('records a definitive refusal as failed', async () => {
    const transport = mockTransport(async () => json(403, {}));
    const res = await run(waitForJob, { jobs: [JOB] }, makeCtx({ transport }));
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { jobs: [{ state: 'failed' }] } });
  });

  it('reports an unknown kind as an error', async () => {
    const res = await run(waitForJob, { jobs: ['image_job:abc'] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Unknown job/);
  });

  it.each(['constructor:abc', '__proto__:abc', 'toString:abc'])('treats %s as an unknown job kind', async job => {
    const res = await run(waitForJob, { jobs: [job] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Unknown job/);
  });

  it('never calls the transport for a malformed id', async () => {
    const transport = mockTransport();
    for (const bad of ['confirmation:..', 'confirmation:', 'confirmation:xyz', 'confirmation', ':abc']) {
      const res = await run(waitForJob, { jobs: [JOB, bad] }, makeCtx({ transport }));
      expect(res.isError).toBe(true);
    }
    expect(transport.call).not.toHaveBeenCalled();
  });
});

describe('stop_job', () => {
  it('withdraws a confirmation', async () => {
    const transport = mockTransport(async () => json(204, undefined));
    const res = await stopJob.handler({ job: JOB }, makeCtx({ transport }));
    expect(transport.call).toHaveBeenCalledWith('withdrawMcpConfirmation', {
      params: { id: ID },
      signal: expect.any(AbortSignal),
    });
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { state: 'cancelled' } });
  });

  it('reports not_found for a confirmation that no longer exists', async () => {
    const res = await stopJob.handler({ job: JOB }, makeCtx({ transport: mockTransport(async () => json(404, {})) }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { state: 'not_found' } });
  });

  it('rejects a bad id without a transport call', async () => {
    const transport = mockTransport();
    const res = await stopJob.handler({ job: 'confirmation:../x' }, makeCtx({ transport }));
    expect(res.isError).toBe(true);
    expect(transport.call).not.toHaveBeenCalled();
  });
});
