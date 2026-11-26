import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import type { AuthState } from '@shared/auth';
import { IPC_CHANNELS } from '@shared/ipc';
import { HostEventRelay } from '../../host/server';
import type { HostEventSink } from '../../host';
import type { HostControl, HostServerRuntime } from '../../host/server';
import { LOCAL_HOST_ID } from './ConnectionManager';
import { registerHostConnections } from './registerHostConnections';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [] },
}));

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly sent: Array<[string, unknown]> = [];
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload]);
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const silentSink: HostEventSink = {
  streamEvent: () => undefined,
  sessionSummary: () => undefined,
  sessionStatus: () => undefined,
  queueChanged: () => undefined,
  taskDecisions: () => undefined,
  loopChanged: () => undefined,
};

const facts = async () => ({
  hostId: 'host-from-control',
  hostName: 'dev-machine',
  hostVersion: '1.2.3',
  capabilities: [],
  platform: 'darwin',
  homeDirectory: '/Users/dev',
});

const signedOutControl: HostControl = { facts, account: () => null, onAccountChanged: () => () => undefined };

function setUp(control: HostControl = signedOutControl) {
  const relay = new HostEventRelay(error => {
    throw error;
  });
  const runtime = {
    listSessions: async () => [{ id: 's1' } as ChatSessionSummary],
    service: { eventsSince: () => ({ ok: true as const, events: [] }) },
    eventLog: { cursor: () => ({ epoch: 'e', seq: 0 }) },
  } as unknown as HostServerRuntime;
  const manager = registerHostConnections(
    { runtime, events: relay, logger: { warn: vi.fn() } },
    {
      control,
      auth: { getState: () => ({ status: 'signed-out' }) as AuthState },
      onAuthStateChanged: () => () => undefined,
      version: '1.2.3',
      signals: { isOnline: () => true, onWake: () => () => undefined, onOnline: () => () => undefined },
    }
  );
  const request = handlers.get(IPC_CHANNELS.hostRequest);
  if (!request) throw new Error('host:request was not registered');
  return {
    manager,
    sink: relay.tee(silentSink),
    request: (sender: FakeWebContents, ...args: unknown[]) => request({ sender }, ...args),
  };
}

describe('registerHostConnections', () => {
  beforeEach(() => handlers.clear());

  it('serves host/info from the control it was given', async () => {
    const { request } = setUp();

    await expect(request(new FakeWebContents(1), LOCAL_HOST_ID, 'host/info', undefined)).resolves.toMatchObject({
      ok: true,
      result: { hostId: 'host-from-control' },
    });
  });

  it('serves the local host to a window and pushes its notifications to that window', async () => {
    const { request, sink } = setUp();
    const window = new FakeWebContents(1);

    await expect(request(window, LOCAL_HOST_ID, 'session/list', undefined)).resolves.toEqual({
      ok: true,
      result: { sessions: [{ id: 's1' }] },
    });
    sink.sessionSummary({ id: 's1', title: 'Renamed' } as ChatSessionSummary);

    expect(window.sent).toEqual([
      [
        IPC_CHANNELS.hostNotification,
        {
          hostId: LOCAL_HOST_ID,
          notification: {
            jsonrpc: '2.0',
            method: 'session/summaryChanged',
            params: { summary: { id: 's1', title: 'Renamed' } },
          },
        },
      ],
    ]);
  });

  it('stops pushing to a window once it is destroyed, and still reaches the others', async () => {
    const { request, sink } = setUp();
    const gone = new FakeWebContents(1);
    const open = new FakeWebContents(2);
    await request(gone, LOCAL_HOST_ID, 'session/list', undefined);
    await request(open, LOCAL_HOST_ID, 'session/list', undefined);

    gone.destroy();
    sink.sessionSummary({ id: 's1' } as ChatSessionSummary);

    expect(gone.sent).toEqual([]);
    expect(open.sent).toHaveLength(1);
  });

  it('refuses a request from a window that is already destroyed', async () => {
    const { request } = setUp();
    const window = new FakeWebContents(1);
    window.destroyed = true;
    await expect(request(window, LOCAL_HOST_ID, 'session/list', undefined)).resolves.toMatchObject({ ok: false });
  });

  it('connects the local host through the handshake while signed out, and serves the host list', async () => {
    const { manager } = setUp();
    await vi.waitFor(() => expect(manager.list()[0]?.state.status).toBe('connected'));
    const list = handlers.get(IPC_CHANNELS.hostList);
    expect(list?.({})).toEqual([
      {
        hostId: LOCAL_HOST_ID,
        label: 'This computer',
        kind: 'local',
        state: expect.objectContaining({ status: 'connected' }),
      },
    ]);
    expect(() => handlers.get(IPC_CHANNELS.hostRemove)?.({}, LOCAL_HOST_ID)).toThrow('cannot be removed');
    expect(() => handlers.get(IPC_CHANNELS.hostConnect)?.({}, 42)).toThrow('Not a host id');
  });
});
