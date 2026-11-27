import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { encodeHostFrame, hostResult, type HostNotification, type HostRequest } from '@shared/hostProtocol';
import type { HeadlessHost } from './composeHeadlessHost';
import { runConnect } from './connect';
import { startDaemon, type RunningDaemon } from './daemon';
import { daemonPaths, inspectDaemon } from './daemonFiles';
import { HOST_EXIT_CODES } from './exitCodes';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const echoHost = {
  hostId: 'host-1',
  server: {
    connect: (_notify: (notification: HostNotification) => void) => ({
      handle: async (request: HostRequest) => hostResult(request.id, { method: request.method }),
      close: () => undefined,
    }),
  },
  dispose: () => undefined,
} as unknown as HeadlessHost;

const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

const daemons: RunningDaemon[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
});

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

// The runner's TMPDIR is too deep for a unix socket path, so these live directly under /tmp.
async function dataDirectory(): Promise<string> {
  const root = await mkdtemp('/tmp/b4mh-');
  scratch.push(root);
  return join(root, 'host');
}

async function startInProcess(dataDirectory: string, version: string) {
  const daemon = await startDaemon({ dataDirectory, version, logger: logger(), compose: async () => echoHost });
  daemons.push(daemon);
  return daemon;
}

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    written += chunk;
  });
  return { stdin, stdout, output: () => written };
}

describePosix('runConnect', () => {
  it('starts a daemon when none is running, bridges stdio to it and leaves it running at EOF', async () => {
    const directory = await dataDirectory();
    const io = streams();
    const log = logger();
    const spawnDaemon = vi.fn(() => void startInProcess(directory, '1.0.0'));

    const exited = runConnect({ dataDirectory: directory, version: '1.0.0', ...io, logger: log, spawnDaemon });
    io.stdin.write(encodeHostFrame({ jsonrpc: '2.0', id: 1, method: 'session/list' }));
    await vi.waitFor(() => expect(io.output()).not.toBe(''));
    io.stdin.end();

    expect(await exited).toBe(HOST_EXIT_CODES.ok);
    expect(spawnDaemon).toHaveBeenCalledOnce();
    // stdout carries the daemon's frames and nothing else.
    expect(io.output()).toBe(encodeHostFrame(hostResult(1, { method: 'session/list' })));
    expect(await inspectDaemon(daemonPaths(directory))).toMatchObject({ state: 'running' });
  });

  it('connects to a running daemon without starting another', async () => {
    const directory = await dataDirectory();
    await startInProcess(directory, '1.0.0');
    const io = streams();
    const spawnDaemon = vi.fn();

    const exited = runConnect({ dataDirectory: directory, version: '1.0.0', ...io, logger: logger(), spawnDaemon });
    io.stdin.end(encodeHostFrame({ jsonrpc: '2.0', id: 7, method: 'host/info' }));

    expect(await exited).toBe(HOST_EXIT_CODES.ok);
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(io.output()).toBe(encodeHostFrame(hostResult(7, { method: 'host/info' })));
  });

  it('exits with the version-mismatch code when the running daemon is another build', async () => {
    const directory = await dataDirectory();
    await startInProcess(directory, '0.9.0');
    const io = streams();
    const log = logger();

    const code = await runConnect({
      dataDirectory: directory,
      version: '1.0.0',
      ...io,
      logger: log,
      spawnDaemon: vi.fn(),
    });

    expect(code).toBe(HOST_EXIT_CODES.daemonVersionMismatch);
    expect(io.output()).toBe('');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('version 0.9.0'));
  });

  it('gives up with the start-timeout code when the daemon never answers', async () => {
    const directory = await dataDirectory();
    const io = streams();
    const log = logger();

    const code = await runConnect({
      dataDirectory: directory,
      version: '1.0.0',
      ...io,
      logger: log,
      spawnDaemon: vi.fn(),
      startTimeoutMs: 300,
    });

    expect(code).toBe(HOST_EXIT_CODES.daemonStartTimeout);
    expect(io.output()).toBe('');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('did not start'));
  });

  it('exits with the connection-lost code when the daemon goes away mid-session', async () => {
    const directory = await dataDirectory();
    const daemon = await startInProcess(directory, '1.0.0');
    const io = streams();

    const exited = runConnect({
      dataDirectory: directory,
      version: '1.0.0',
      ...io,
      logger: logger(),
      spawnDaemon: vi.fn(),
    });
    io.stdin.write(encodeHostFrame({ jsonrpc: '2.0', id: 1, method: 'session/list' }));
    await vi.waitFor(() => expect(io.output()).not.toBe(''));
    await daemon.close();
    daemons.splice(0);

    expect(await exited).toBe(HOST_EXIT_CODES.daemonConnectionLost);
  });

  it('ends when stdout closes, leaving the daemon running', async () => {
    const directory = await dataDirectory();
    await startInProcess(directory, '1.0.0');
    const io = streams();

    const exited = runConnect({
      dataDirectory: directory,
      version: '1.0.0',
      ...io,
      logger: logger(),
      spawnDaemon: vi.fn(),
    });
    io.stdin.write(encodeHostFrame({ jsonrpc: '2.0', id: 1, method: 'session/list' }));
    await vi.waitFor(() => expect(io.output()).not.toBe(''));
    io.stdout.destroy();

    expect(await exited).toBe(HOST_EXIT_CODES.ok);
    expect(await inspectDaemon(daemonPaths(directory))).toMatchObject({ state: 'running' });
  });
});
