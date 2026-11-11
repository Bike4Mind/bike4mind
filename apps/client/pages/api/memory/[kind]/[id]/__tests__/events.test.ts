import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  appendMemoryEvent: vi.fn(),
  listPrincipalLedger: vi.fn(),
  createKeyProvider: vi.fn(() => ({})),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ memoryLedgerRepository: {}, memoryPrincipalKeyRepository: {} }));
vi.mock('@bike4mind/server-utils/memory/ledgerMemoryStore', () => ({
  appendMemoryEvent: h.appendMemoryEvent,
  listPrincipalLedger: h.listPrincipalLedger,
}));
vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({ createKeyProvider: h.createKeyProvider }));

import handler from '../events';

// A fixed PAST instant, so a handler that re-stamps with `new Date()` cannot pass by coincidence.
const receivedAt = new Date('2026-01-01T00:00:00.000Z');

const invoke = (overrides: Record<string, unknown> = {}) => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const setHeader = vi.fn();
  const done = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'POST',
      query: { kind: 'user', id: 'user-1' },
      body: { kind: 'assert', fact: 'Prefers dark roast coffee' },
      user: { id: 'user-1' },
      receivedAt,
      ...overrides,
    },
    { status, setHeader }
  );
  return { json, status, setHeader, done };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.appendMemoryEvent.mockResolvedValue({ id: 'event-1' });
  h.listPrincipalLedger.mockResolvedValue([{ hash: 'hash-1' }]);
});

describe('GET /api/memory/:kind/:id/events', () => {
  it('denies anonymous, foreign, and non-user reads without querying the ledger', async () => {
    await invoke({ method: 'GET', user: undefined }).done;
    await invoke({ method: 'GET', query: { kind: 'user', id: 'other' } }).done;
    await invoke({ method: 'GET', query: { kind: 'lake', id: 'user-1' } }).done;
    expect(h.listPrincipalLedger).not.toHaveBeenCalled();
  });

  it('returns the complete owner-scoped ledger without caching', async () => {
    const { json, status, setHeader, done } = invoke({ method: 'GET' });
    await done;
    expect(h.listPrincipalLedger).toHaveBeenCalledWith(
      expect.objectContaining({ principal: { kind: 'user', id: 'user-1' }, ownerUserId: 'user-1' })
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(json).toHaveBeenCalledWith({ events: [{ hash: 'hash-1' }] });
  });
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
