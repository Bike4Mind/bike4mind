import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostFrameDecoder,
  encodeHostFrame,
  HOST_ERROR_CODES,
  type HostMessage,
  type HostNotification,
  type HostRequest,
  type HostResponse,
} from '@shared/hostProtocol';
import { serveHostSocket, type ServeSocketOptions } from './socketTransport';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

type FakeConnection = { handle(request: HostRequest): Promise<HostResponse>; close(): void };

const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

const servers: Server[] = [];
const sockets: Socket[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

/** Serves `connection` on a fresh unix socket and returns a connected raw client. */
async function serve(connection: FakeConnection, options: ServeSocketOptions = {}) {
  // The runner's TMPDIR is too deep for a unix socket path, so this lives directly under /tmp.
  const root = await mkdtemp('/tmp/b4mh-');
  scratch.push(root);
  const path = join(root, 'host.sock');
  const log = logger();
  const notifiers: Array<(notification: HostNotification) => void> = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.push(socket);
    serveHostSocket(
      socket,
      {
        connect: notify => {
          notifiers.push(notify);
          return connection;
        },
      },
      log,
      options
    );
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve));

  const client = connect(path);
  sockets.push(client);
  const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  return { client, closed, log, notifiers };
}

function collect(client: Socket): HostMessage[] {
  const decoder = createHostFrameDecoder();
  const received: HostMessage[] = [];
  client.setEncoding('utf8');
  client.on('data', (chunk: string) => {
    for (const frame of decoder.push(chunk)) if (frame.ok) received.push(frame.message);
  });
  return received;
}

describePosix('serveHostSocket', () => {
  it('answers a request whose handler rejects and still ends a half-closed connection', async () => {
    const connection = { handle: vi.fn(() => Promise.reject(new Error('boom'))), close: vi.fn() };
    const { client, closed, log } = await serve(connection);
    const received = collect(client);

    client.write(encodeHostFrame({ jsonrpc: '2.0', id: 7, method: 'session/list' }));
    client.end();
    await closed;

    expect(received).toEqual([
      expect.objectContaining({ id: 7, error: expect.objectContaining({ code: HOST_ERROR_CODES.internalError }) }),
    ]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.any(Error));
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('drops a client that leaves more than the limit unread', async () => {
    const connection = { handle: vi.fn(), close: vi.fn() };
    const { client, closed, log, notifiers } = await serve(connection, { maxUnreadOutputBytes: 64 * 1024 });
    client.pause();
    await vi.waitFor(() => expect(notifiers).toHaveLength(1));
    const [notify] = notifiers;

    const text = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200 && connection.close.mock.calls.length === 0; i++) {
      notify({ jsonrpc: '2.0', method: 'host/stateChanged', params: { text } } as unknown as HostNotification);
    }
    client.resume();
    await closed;

    expect(connection.close).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unread'));
  });
});
