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
    const p = run(waitForJob, { jobs: [JOB], max_wait_seconds: 900 }, makeCtx({ transport, kind }));
    await vi.advanceTimersByTimeAsync(budget * 1000 + 10_000);
    const res = await p;
    expect(res.structuredContent).toMatchObject({ status: 'pending' });
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
    expect(Date.now()).toBeLessThan(new Date('2100-01-01').getTime());
    expect(transport.call.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('records a transport failure against that job only', async () => {
    const transport = mockTransport(async () => json(500, {}));
    const res = await run(waitForJob, { jobs: [JOB] }, makeCtx({ transport }));
    expect(res.structuredContent).toMatchObject({ result: { jobs: [{ state: 'failed' }] } });
  });

  it('reports an unknown kind as an error', async () => {
    const res = await run(waitForJob, { jobs: ['image_job:abc'] });
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
    expect(transport.call).toHaveBeenCalledWith('withdrawMcpConfirmation', { params: { id: ID } });
    expect(res.structuredContent).toMatchObject({ status: 'done', result: { state: 'cancelled' } });
  });

  it('treats an already-gone confirmation as stopped', async () => {
    const res = await stopJob.handler({ job: JOB }, makeCtx({ transport: mockTransport(async () => json(404, {})) }));
    expect(res.isError).toBeUndefined();
  });

  it('rejects a bad id without a transport call', async () => {
    const transport = mockTransport();
    const res = await stopJob.handler({ job: 'confirmation:../x' }, makeCtx({ transport }));
    expect(res.isError).toBe(true);
    expect(transport.call).not.toHaveBeenCalled();
  });
});
