import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerHistoryIpc } from './historyIpc';

function setup(available = true) {
  const service = {
    setSessionHistory: vi.fn(async () => null),
    searchHistory: vi.fn(() => []),
  };
  const history = { clear: vi.fn(() => ({ entries: 0 })), state: vi.fn(() => ({ entries: 7 })) };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerHistoryIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
      },
    },
    service,
    available ? history : undefined
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Handler not registered: ${channel}`);
    return handler({}, ...args);
  };
  return { service, history, call };
}

describe('local history IPC', () => {
  it('forwards opt-in and opt-out to the service with their exact session identity', async () => {
    const { service, call } = setup();
    await call(IPC_CHANNELS.chatSetSessionHistory, 'first', true);
    expect(service.setSessionHistory).toHaveBeenLastCalledWith('first', true);
    await call(IPC_CHANNELS.chatSetSessionHistory, 'second', false);
    expect(service.setSessionHistory).toHaveBeenLastCalledWith('second', false);
  });

  it('rejects malformed input without changing the session or coercing objects into searches', () => {
    const { service, call } = setup();
    expect(() => call(IPC_CHANNELS.chatSetSessionHistory, 'first', 'false')).toThrow();
    expect(() => call(IPC_CHANNELS.chatSetSessionHistory, '', true)).toThrow();
    expect(() => call(IPC_CHANNELS.chatSearchHistory, {})).toThrow();
    expect(service.setSessionHistory).not.toHaveBeenCalled();
    expect(service.searchHistory).not.toHaveBeenCalled();
  });

  it('forwards queries and exposes the real scoped count and clear result', () => {
    const { service, history, call } = setup();
    expect(call(IPC_CHANNELS.chatSearchHistory, 'moon launch')).toEqual([]);
    expect(service.searchHistory).toHaveBeenLastCalledWith('moon launch');
    expect(call(IPC_CHANNELS.chatHistoryState)).toEqual({ entries: 7 });
    expect(history.state).toHaveBeenCalledTimes(1);
    expect(call(IPC_CHANNELS.chatClearHistory)).toEqual({ entries: 0 });
    expect(history.clear).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable storage instead of claiming a successful clear or an empty index', () => {
    const { call } = setup(false);
    expect(() => call(IPC_CHANNELS.chatClearHistory)).toThrow('Local history is unavailable');
    expect(() => call(IPC_CHANNELS.chatHistoryState)).toThrow('Local history is unavailable');
  });

  it('propagates storage failures instead of reporting success', () => {
    const { history, call } = setup();
    history.clear.mockImplementation(() => {
      throw new Error('disk failure');
    });
    expect(() => call(IPC_CHANNELS.chatClearHistory)).toThrow('disk failure');
  });
});
