import { describe, expect, it, vi } from 'vitest';
import type { BrowserPageModel } from '@shared/browserPage';
import type { ChatSession } from '@shared/chat';
import { captureHistoryPage } from './captureHistoryPage';
import { LocalHistory } from './LocalHistory';

const model: BrowserPageModel = {
  url: 'https://example.com/',
  title: 'Example',
  capturedAt: '2026-10-24T12:00:00.000Z',
  blocks: [],
  actions: [],
  claims: [],
  truncated: false,
};
const enabled = { historyEnabled: true } as ChatSession;

function setup() {
  const history = { capturePage: vi.fn(), revision: () => 0 };
  const store = { get: vi.fn(async () => enabled as ChatSession | null) };
  let scope: string | null = 'account-a';
  return {
    history,
    store,
    scopeKey: () => scope,
    setScope: (next: string | null) => {
      scope = next;
    },
  };
}

describe('page history capture', () => {
  it('indexes the exact snapshot only after confirming its owning session opted in', async () => {
    const dependencies = setup();
    await captureHistoryPage('owner', model, dependencies);
    expect(dependencies.store.get).toHaveBeenCalledWith('owner');
    expect(dependencies.history.capturePage).toHaveBeenCalledWith('owner', model, 0);
    expect(dependencies.history.capturePage.mock.calls[0][1]).toBe(model);
  });

  it.each([null, {} as ChatSession])('does not index missing or opted-out sessions', async session => {
    const dependencies = setup();
    dependencies.store.get.mockResolvedValue(session);
    await captureHistoryPage('owner', model, dependencies);
    expect(dependencies.history.capturePage).not.toHaveBeenCalled();
  });

  it('does not read or index sessions while signed out or history is unavailable', async () => {
    const dependencies = setup();
    dependencies.setScope(null);
    await captureHistoryPage('owner', model, dependencies);
    dependencies.setScope('account-a');
    await captureHistoryPage('owner', model, { ...dependencies, history: undefined });
    expect(dependencies.store.get).not.toHaveBeenCalled();
    expect(dependencies.history.capturePage).not.toHaveBeenCalled();
  });

  it.each(['account-b', null])('does not write a previous account snapshot after switching to %s', async scope => {
    const dependencies = setup();
    dependencies.store.get.mockImplementation(async () => {
      dependencies.setScope(scope);
      return enabled;
    });
    await captureHistoryPage('owner', model, dependencies);
    expect(dependencies.history.capturePage).not.toHaveBeenCalled();
  });

  it('propagates read failures for BrowserManager to report instead of guessing consent', async () => {
    const dependencies = setup();
    dependencies.store.get.mockRejectedValue(new Error('read failed'));
    await expect(captureHistoryPage('owner', model, dependencies)).rejects.toThrow('read failed');
    expect(dependencies.history.capturePage).not.toHaveBeenCalled();
  });

  it.each(['remove', 'clear'] as const)(
    'does not restore removed history after a pending consent read (%s)',
    async action => {
      const history = new LocalHistory(':memory:');
      let finishRead: (session: ChatSession) => void = () => undefined;
      const store = {
        get: () =>
          new Promise<ChatSession>(resolve => {
            finishRead = resolve;
          }),
      };
      const searchable = { ...model, blocks: [{ id: 'b', kind: 'text' as const, text: 'private moon' }] };
      try {
        const capture = captureHistoryPage('owner', searchable, { history, store, scopeKey: () => 'default' });
        if (action === 'remove') history.removeSession('owner');
        else history.clear();
        finishRead(enabled);
        await capture;
        expect(history.state()).toEqual({ entries: 0 });
        expect(history.search('private moon')).toEqual([]);
        // Fresh consent reads still capture after the invalidation.
        await captureHistoryPage('owner', searchable, {
          history,
          store: { get: async () => enabled },
          scopeKey: () => 'default',
        });
        expect(history.state()).toEqual({ entries: 1 });
      } finally {
        history.close();
      }
    }
  );
});
