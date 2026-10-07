import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  appendMemoryEvent: vi.fn(),
  createKeyProvider: vi.fn(() => ({})),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ memoryLedgerRepository: {}, memoryPrincipalKeyRepository: {} }));
vi.mock('@server/memory/ledgerMemoryStore', () => ({ appendMemoryEvent: h.appendMemoryEvent }));
vi.mock('@server/memory/factCipher', () => ({ createKeyProvider: h.createKeyProvider }));

import handler from '../events';

// A fixed PAST instant, so a handler that re-stamps with `new Date()` cannot pass by coincidence.
const receivedAt = new Date('2026-01-01T00:00:00.000Z');

const invoke = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const done = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      query: { kind: 'user', id: 'user-1' },
      body: { kind: 'assert', fact: 'Prefers dark roast coffee' },
      user: { id: 'user-1' },
      receivedAt,
    },
    { status }
  );
  return { json, status, done };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.appendMemoryEvent.mockResolvedValue({ id: 'event-1' });
});

describe('POST /api/memory/:kind/:id/events', () => {
  it("arms the shred fence with the request's arrival, not a handler-local stamp", async () => {
    // A purge landing between arrival and the append - across baseApi's connectDB and auth as well
    // as this handler's own parsing - must refuse the write, not lift its own tombstone.
    // baseApi.receivedAt.test.ts pins that the stamp is taken first.
    await invoke().done;

    expect(h.appendMemoryEvent.mock.calls[0][4].startedAt).toBe(receivedAt);
  });

  it('answers 409 when the fence refuses the write', async () => {
    h.appendMemoryEvent.mockResolvedValue(null);
    const { status, done } = invoke();
    await done;

    expect(status).toHaveBeenCalledWith(409);
  });

  it('answers 201 with the sealed event on success', async () => {
    const { status, json, done } = invoke();
    await done;

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ event: { id: 'event-1' } });
  });
});
