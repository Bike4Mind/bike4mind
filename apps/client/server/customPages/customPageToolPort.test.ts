import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendToClient: vi.fn(),
  findByOrchestratorSession: vi.fn(),
  patchState: vi.fn(),
  setWidget: vi.fn(),
  removeWidget: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://ws.test' } } }));
vi.mock('@bike4mind/database', () => ({
  Connection: {},
  customPageRepository: { findByOrchestratorSession: mocks.findByOrchestratorSession },
}));
vi.mock('@bike4mind/utils', () => ({
  ClientMessageSender: class {
    sendToClient = mocks.sendToClient;
  },
}));
vi.mock('@bike4mind/services', () => ({
  customPageService: {
    patchState: mocks.patchState,
    setWidget: mocks.setWidget,
    removeWidget: mocks.removeWidget,
  },
}));

import { createCustomPageToolPort } from './customPageToolPort';

const logger = { warn: vi.fn() } as never;
const ok = { ok: true, page: { id: 'a'.repeat(24) } };
const ref = { pageId: 'a'.repeat(24), userId: 'user-1' };

describe('createCustomPageToolPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendToClient.mockResolvedValue(undefined);
  });

  it('findForSession returns a snapshot, or null for no page', async () => {
    const port = createCustomPageToolPort({ logger });
    mocks.findByOrchestratorSession.mockResolvedValueOnce(null);
    expect(await port.findForSession('s1', 'user-1')).toBeNull();

    mocks.findByOrchestratorSession.mockResolvedValueOnce({ id: 'p1', name: 'N', state: { a: 1 }, widgets: [] });
    expect(await port.findForSession('s1', 'user-1')).toEqual({ id: 'p1', name: 'N', state: { a: 1 }, widgets: [] });
    expect(mocks.findByOrchestratorSession).toHaveBeenCalledWith('s1', 'user-1');
  });

  it.each([
    ['patchState', mocks.patchState, { ...ref, patch: { a: 1 } }],
    ['setWidget', mocks.setWidget, { ...ref, widget: { id: 'w' } }],
    ['removeWidget', mocks.removeWidget, { ...ref, widgetId: 'w' }],
  ] as const)('%s invalidates the page query after a successful write', async (name, service, params) => {
    service.mockResolvedValue(ok);
    const port = createCustomPageToolPort({ logger });
    expect(await port[name](params as never)).toBe(ok);
    expect(mocks.sendToClient).toHaveBeenCalledWith('user-1', 'wss://ws.test', {
      action: 'invalidate_query',
      queryKey: ['custom-page', ref.pageId],
    });
  });

  it('does not push when the service reports a failure', async () => {
    const failure = { ok: false, code: 'invalid', message: 'bad' };
    mocks.setWidget.mockResolvedValue(failure);
    const port = createCustomPageToolPort({ logger });
    expect(await port.setWidget({ ...ref, widget: {} })).toBe(failure);
    expect(mocks.sendToClient).not.toHaveBeenCalled();
  });

  it('swallows a websocket send failure', async () => {
    mocks.patchState.mockResolvedValue(ok);
    mocks.sendToClient.mockRejectedValue(new Error('gone'));
    const port = createCustomPageToolPort({ logger });
    await expect(port.patchState({ ...ref, patch: { a: 1 } })).resolves.toBe(ok);
  });
});
