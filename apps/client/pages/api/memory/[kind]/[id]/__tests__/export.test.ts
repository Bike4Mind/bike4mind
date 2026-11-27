import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exportPrincipalMemory: vi.fn(), listPrincipalLedger: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
  mementoRepository: {},
}));
vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({ createKeyProvider: () => ({}) }));
vi.mock('@bike4mind/server-utils/memory/exportPrincipalMemory', () => ({
  exportPrincipalMemory: h.exportPrincipalMemory,
}));
vi.mock('@bike4mind/server-utils/memory/ledgerMemoryStore', () => ({ listPrincipalLedger: h.listPrincipalLedger }));

import exportHandler from '../export';
import eventHandler from '../events/[hash]';

const invoke = async (handler: typeof exportHandler, userId?: string, id = 'u1', kind = 'user') => {
  const json = vi.fn();
  const setHeader = vi.fn();
  const status = vi.fn(() => ({ json }));
  await handler(
    { query: { kind, id, hash: 'hash-1' }, user: userId ? { id: userId } : undefined } as never,
    { status, setHeader } as never
  );
  return { json, setHeader, status };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.exportPrincipalMemory.mockResolvedValue({ events: [], beliefs: [], mementos: [] });
  h.listPrincipalLedger.mockResolvedValue([{ hash: 'hash-1' }]);
});

describe('owner-scoped export and event read', () => {
  it.each([exportHandler, eventHandler])('blocks anonymous and foreign users before reading', async handler => {
    expect((await invoke(handler)).status).toHaveBeenCalledWith(401);
    expect((await invoke(handler, 'u2')).status).toHaveBeenCalledWith(403);
    expect((await invoke(handler, 'u1', 'u1', 'lake')).status).toHaveBeenCalledWith(400);
    expect(h.exportPrincipalMemory).not.toHaveBeenCalled();
    expect(h.listPrincipalLedger).not.toHaveBeenCalled();
  });

  it('exports the authorized user with no-store caching', async () => {
    const { status, setHeader } = await invoke(exportHandler, 'u1');
    expect(status).toHaveBeenCalledWith(200);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(h.exportPrincipalMemory).toHaveBeenCalledWith(
      expect.objectContaining({ principal: { kind: 'user', id: 'u1' }, ownerUserId: 'u1' })
    );
  });

  it('reads one event only from the authorized chain', async () => {
    const { json } = await invoke(eventHandler, 'u1');
    expect(json).toHaveBeenCalledWith({ event: { hash: 'hash-1' } });
  });

  it('answers 404 when no event in the authorized chain matches the hash', async () => {
    h.listPrincipalLedger.mockResolvedValue([{ hash: 'other' }]);
    const { status, json } = await invoke(eventHandler, 'u1');
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Memory event not found.' });
  });
});
