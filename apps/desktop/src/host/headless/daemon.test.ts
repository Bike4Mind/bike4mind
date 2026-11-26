import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostFrameDecoder,
  encodeHostFrame,
  HOST_ERROR_CODES,
  hostResult,
  MAX_HOST_FRAME_LENGTH,
  type HostMessage,
  type HostNotification,
  type HostRequest,
} from '@shared/hostProtocol';
import type { HeadlessHost } from './composeHeadlessHost';
import { startDaemon, type RunningDaemon } from './daemon';
import { DaemonAlreadyRunningError, daemonPaths, inspectDaemon, type LockRecord } from './daemonFiles';

vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * A stand-in host: answers every request with the method it was asked, holds `slow` until
 * released, and lets a test push a notification to every connection.
 */
function fakeHost() {
  const listeners = new Set<(notification: HostNotification) => void>();
  const slow: Array<() => void> = [];
  const dispose = vi.fn();
  const server = {
    connect(notify: (notification: HostNotification) => void) {
      listeners.add(notify);
      return {
        handle: async (request: HostRequest) => {
          if (request.method === 'slow') await new Promise<void>(resolve => slow.push(resolve));
          return hostResult(request.id, { method: request.method });
        },
        close: () => listeners.delete(notify),
      };
    },
  };
  const host = { hostId: 'host-1', server, dispose } as unknown as HeadlessHost;
  return {
    host,
    dispose,
    listeners,
    heldCount: () => slow.length,
    releaseSlow: () => slow.splice(0).forEach(resolve => resolve()),
    broadcast: (notification: HostNotification) => listeners.forEach(listener => listener(notification)),
  };
}

const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

const daemons: RunningDaemon[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const daemon of daemons.splice(0)) await daemon.close();
});

const scratch: string[] = [];

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

// The runner's TMPDIR is too deep for a unix socket path, so these live directly under /tmp.
async function dataDirectory(): Promise<string> {
  const root = await mkdtemp('/tmp/b4mh-');
  scratch.push(root);
  return join(root, 'host');
}

async function start(directory: string, fake = fakeHost(), version = '1.0.0') {
  const daemon = await startDaemon({
    dataDirectory: directory,
    version,
    logger: logger(),
    compose: async () => fake.host,
  });
  daemons.push(daemon);
  return daemon;
}

/** A daemon whose host is still composing: `compose` stays pending until `finish` hands it a host. */
function startComposing(directory: string, version = '1.0.0') {
  let finish!: (host: HeadlessHost) => void;
  const composed = new Promise<HeadlessHost>(resolve => {
    finish = resolve;
  });
  const starting = startDaemon({ dataDirectory: directory, version, logger: logger(), compose: () => composed }).then(
    daemon => {
      daemons.push(daemon);
      return daemon;
    }
  );
  return { starting, finish, paths: daemonPaths(directory) };
}

/** A raw client on the daemon's socket that collects every frame it receives. */
async function client(path: string) {
  const socket = connect(path);
  sockets.push(socket);
  const decoder = createHostFrameDecoder();
  const received: HostMessage[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    for (const frame of decoder.push(chunk)) if (frame.ok) received.push(frame.message);
  });
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const send = (method: string) => {
    const id = nextId++;
    socket.write(encodeHostFrame({ jsonrpc: '2.0', id, method }));
    return id;
  };
  return { socket, received, closed, send };
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

async function writeLock(directory: string, record: LockRecord) {
  await writeFile(daemonPaths(directory).lock, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

describePosix('startDaemon', () => {
  it('serves concurrent clients, each on its own connection', async () => {
    const fake = fakeHost();
    const daemon = await start(await dataDirectory(), fake);
    const first = await client(daemon.paths.socket);
    const second = await client(daemon.paths.socket);

    first.send('session/list');
    second.send('host/info');
    await vi.waitFor(() => {
      expect(first.received).toEqual([hostResult(1, { method: 'session/list' })]);
      expect(second.received).toEqual([hostResult(1, { method: 'host/info' })]);
    });

    fake.broadcast({ jsonrpc: '2.0', method: 'host/stateChanged', params: { account: null } });
    await vi.waitFor(() => {
      expect(first.received).toHaveLength(2);
      expect(second.received).toHaveLength(2);
    });
    expect(fake.listeners.size).toBe(2);
  });

  it('keeps running after the last client leaves', async () => {
    const fake = fakeHost();
    const daemon = await start(await dataDirectory(), fake);
    const first = await client(daemon.paths.socket);
    first.socket.destroy();
    await first.closed;
    await vi.waitFor(() => expect(fake.listeners.size).toBe(0));

    const next = await client(daemon.paths.socket);
    next.send('session/list');
    await vi.waitFor(() => expect(next.received).toHaveLength(1));
    expect(fake.dispose).not.toHaveBeenCalled();
  });

  it('creates the socket and the lock owner-only and records its pid and version', async () => {
    const daemon = await start(await dataDirectory(), fakeHost(), '2.3.4');
    expect((await stat(daemon.paths.socket)).mode & 0o777).toBe(0o600);
    expect((await stat(daemon.paths.lock)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(daemon.paths.lock, 'utf8'))).toMatchObject({ pid: process.pid, version: '2.3.4' });
    expect(await inspectDaemon(daemon.paths)).toMatchObject({ state: 'running' });
  });

  it('refuses to start a second daemon on the same data directory', async () => {
    const directory = await dataDirectory();
    await start(directory);
    const compose = vi.fn();

    await expect(
      startDaemon({ dataDirectory: directory, version: '1.0.0', logger: logger(), compose })
    ).rejects.toThrow(DaemonAlreadyRunningError);
    expect(compose).not.toHaveBeenCalled();
  });

  it('replaces a lock and socket left by a process that is gone', async () => {
    const directory = await dataDirectory();
    await start(directory).then(daemon => daemon.close());
    daemons.splice(0);
    await writeLock(directory, { pid: deadPid(), version: '0.9.0', startedAt: Date.now() });
    await writeFile(daemonPaths(directory).socket, '');

    const daemon = await start(directory);
    const reconnected = await client(daemon.paths.socket);
    reconnected.send('session/list');
    await vi.waitFor(() => expect(reconnected.received).toHaveLength(1));
    expect(JSON.parse(await readFile(daemon.paths.lock, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('replaces a lock whose process is alive but stopped listening long ago', async () => {
    const directory = await dataDirectory();
    await start(directory).then(daemon => daemon.close());
    daemons.splice(0);
    await writeLock(directory, { pid: process.pid, version: '0.9.0', startedAt: Date.now() - 60_000 });

    const daemon = await start(directory);
    expect(JSON.parse(await readFile(daemon.paths.lock, 'utf8'))).toMatchObject({ version: '1.0.0' });
  });

  it('leaves a lock alone while its live process is still starting', async () => {
    const directory = await dataDirectory();
    await start(directory).then(daemon => daemon.close());
    daemons.splice(0);
    await writeLock(directory, { pid: process.pid, version: '0.9.0', startedAt: Date.now() });

    await expect(
      startDaemon({ dataDirectory: directory, version: '1.0.0', logger: logger(), compose: vi.fn() })
    ).rejects.toThrow(DaemonAlreadyRunningError);
    expect(JSON.parse(await readFile(daemonPaths(directory).lock, 'utf8'))).toMatchObject({ version: '0.9.0' });
  });

  it('closes only the connection that sends malformed JSON', async () => {
    const daemon = await start(await dataDirectory());
    const bad = await client(daemon.paths.socket);
    const good = await client(daemon.paths.socket);

    bad.socket.write('{not json\n');
    await bad.closed;
    expect(bad.received).toEqual([
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: HOST_ERROR_CODES.parseError }) }),
    ]);

    good.send('session/list');
    await vi.waitFor(() => expect(good.received).toHaveLength(1));
  });

  it('closes only the connection that sends a frame over the size limit', async () => {
    const daemon = await start(await dataDirectory());
    const bad = await client(daemon.paths.socket);
    const good = await client(daemon.paths.socket);

    bad.socket.write('x'.repeat(MAX_HOST_FRAME_LENGTH + 1));
    await bad.closed;
    expect(bad.received).toEqual([expect.objectContaining({ id: null, error: expect.anything() })]);

    good.send('session/list');
    await vi.waitFor(() => expect(good.received).toHaveLength(1));
  });

  it('answers what a client asked before it half-closed', async () => {
    const fake = fakeHost();
    const daemon = await start(await dataDirectory(), fake);
    const asker = await client(daemon.paths.socket);

    asker.send('slow');
    asker.socket.end();
    await vi.waitFor(() => expect(fake.heldCount()).toBe(1));
    expect(asker.received).toEqual([]);
    fake.releaseSlow();
    await asker.closed;
    expect(asker.received).toEqual([hostResult(1, { method: 'slow' })]);
  });

  it('serves a client that connected while the host was still composing', async () => {
    const fake = fakeHost();
    const composing = startComposing(await dataDirectory());
    const early = await vi.waitFor(() => client(composing.paths.socket));

    early.send('host/initialize');
    expect(early.received).toEqual([]);
    composing.finish(fake.host);
    await composing.starting;

    await vi.waitFor(() => expect(early.received).toEqual([hostResult(1, { method: 'host/initialize' })]));
  });

  it('answers a client that half-closed while the host was still composing, then ends it', async () => {
    const fake = fakeHost();
    const composing = startComposing(await dataDirectory());
    const early = await vi.waitFor(() => client(composing.paths.socket));

    early.send('host/initialize');
    early.socket.end();
    composing.finish(fake.host);
    await composing.starting;

    await early.closed;
    expect(early.received).toEqual([hostResult(1, { method: 'host/initialize' })]);
  });

  it('keeps serving later clients when one that was waiting for the host went away', async () => {
    const fake = fakeHost();
    const composing = startComposing(await dataDirectory());
    const early = await vi.waitFor(() => client(composing.paths.socket));

    early.socket.destroy();
    await early.closed;
    composing.finish(fake.host);
    const daemon = await composing.starting;

    const later = await client(daemon.paths.socket);
    later.send('session/list');
    await vi.waitFor(() => expect(later.received).toEqual([hostResult(1, { method: 'session/list' })]));
  });

  it('logs an error on the socket server and keeps serving', async () => {
    const log = logger();
    const fake = fakeHost();
    const daemon = await startDaemon({
      dataDirectory: await dataDirectory(),
      version: '1.0.0',
      logger: log,
      compose: async () => fake.host,
    });
    daemons.push(daemon);
    const server = vi.mocked(createServer).mock.results.at(-1)?.value as Server;
    const failure = new Error('accept failed');

    server.emit('error', failure);

    expect(log.error).toHaveBeenCalledWith('HOST: socket server error', failure);
    const next = await client(daemon.paths.socket);
    next.send('session/list');
    await vi.waitFor(() => expect(next.received).toEqual([hostResult(1, { method: 'session/list' })]));
  });

  it('shuts down cleanly: drops clients, disposes the host and removes the socket and lock', async () => {
    const fake = fakeHost();
    const daemon = await start(await dataDirectory(), fake);
    const connected = await client(daemon.paths.socket);

    await daemon.close();
    daemons.splice(0);
    await connected.closed;

    expect(fake.dispose).toHaveBeenCalledOnce();
    await expect(stat(daemon.paths.socket)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(daemon.paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inspectDaemon(daemon.paths)).toEqual({ state: 'stopped' });
  });

  it('releases the lock and socket when the host fails to compose', async () => {
    const directory = await dataDirectory();
    await expect(
      startDaemon({
        dataDirectory: directory,
        version: '1.0.0',
        logger: logger(),
        compose: () => Promise.reject(new Error('compose failed')),
      })
    ).rejects.toThrow('compose failed');

    expect(await inspectDaemon(daemonPaths(directory))).toEqual({ state: 'stopped' });
    await expect(stat(daemonPaths(directory).socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
