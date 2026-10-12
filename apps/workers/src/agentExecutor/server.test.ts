import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createExecutorApp, runQueueMessage, executionContext } from './server';
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});
async function start(overrides: Partial<Parameters<typeof createExecutorApp>[0]> = {}) {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const app = createExecutorApp({ secret: 'test-secret', ready: () => true, enqueue, ...overrides });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return { url: `http://127.0.0.1:${address.port}`, enqueue };
}
const payload = {
  executionId: 'e1',
  connectionId: 'c1',
  userId: 'u1',
  sessionId: 's1',
  query: 'hello',
  model: 'local',
};
describe('executor admission', () => {
  it('accepts only after the queue acknowledges durable handoff', async () => {
    const { url, enqueue } = await start();
    const response = await fetch(`${url}/execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(payload);
  });
  it('rejects unauthenticated execution without enqueueing', async () => {
    const { url, enqueue } = await start();
    const response = await fetch(`${url}/execute`, { method: 'POST', body: JSON.stringify(payload) });
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('reports queue outage instead of accepting work', async () => {
    const { url } = await start({
      enqueue: async () => {
        throw new Error('offline');
      },
    });
    const response = await fetch(`${url}/execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(503);
  });
  it('does not accept work while draining', async () => {
    const { url, enqueue } = await start({ ready: () => false });
    expect((await fetch(`${url}/health`)).status).toBe(503);
    expect(
      (
        await fetch(`${url}/execute`, {
          method: 'POST',
          headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      ).status
    ).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
describe('queue execution adapter', () => {
  it('preserves a new execution payload instead of interpreting it as continuation', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await runQueueMessage({ Body: JSON.stringify({ kind: 'selfhost_invoke', payload }), MessageId: 'm1' }, handler);
    expect(handler.mock.calls[0][0]).toEqual(payload);
  });
  it('propagates partial continuation failure so the consumer leaves it for redelivery', async () => {
    const handler = vi.fn().mockResolvedValue({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    await expect(
      runQueueMessage({ Body: JSON.stringify({ executionId: 'e1', connectionId: 'c1' }), MessageId: 'm1' }, handler)
    ).rejects.toThrow(/failed/);
  });
  it('gives handlers a decreasing budget shorter than queue visibility', () => {
    vi.useFakeTimers();
    const context = executionContext();
    const before = context.getRemainingTimeInMillis();
    vi.advanceTimersByTime(1000);
    expect(context.getRemainingTimeInMillis()).toBe(before - 1000);
    expect(before).toBeLessThan(960_000);
    vi.useRealTimers();
  });
});
