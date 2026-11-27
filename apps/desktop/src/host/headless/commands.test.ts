import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { hostResult, type HostNotification, type HostRequest } from '@shared/hostProtocol';
import { readHostStatus, stopDaemon } from './commands';
import type { HeadlessHost } from './composeHeadlessHost';
import { startDaemon, type RunningDaemon } from './daemon';
import { daemonPaths, type LockRecord } from './daemonFiles';
import { HOST_EXIT_CODES } from './exitCodes';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

const daemons: RunningDaemon[] = [];
const scratch: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const daemon of daemons.splice(0)) await daemon.close();
});

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

// The runner's TMPDIR is too deep for a unix socket path, so these live directly under /tmp.
async function dataDirectory(): Promise<string> {
  const root = await mkdtemp('/tmp/b4mh-');
  scratch.push(root);
  const directory = join(root, 'host');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

async function writeLock(directory: string, record: LockRecord) {
  await writeFile(daemonPaths(directory).lock, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** A daemon whose host takes every request and never answers it. */
async function silentDaemon(directory: string) {
  const handled = vi.fn();
  const host = {
    hostId: 'host-1',
    server: {
      connect: (_notify: (notification: HostNotification) => void) => ({
        handle: (request: HostRequest) => {
          handled(request.method);
          return new Promise(() => undefined);
        },
        close: () => undefined,
      }),
    },
    dispose: () => undefined,
  } as unknown as HeadlessHost;
  const daemon = await startDaemon({
    dataDirectory: directory,
    version: '1.2.3',
    logger: logger(),
    compose: async () => host,
  });
  daemons.push(daemon);
  return { daemon, handled };
}

/** Lets a SIGTERM to the test process itself be observed instead of delivered. */
function interceptSigterm(onSigterm: () => void) {
  const kill = process.kill.bind(process);
  return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 'SIGTERM') {
      onSigterm();
      return true;
    }
    return kill(pid, signal);
  });
}

/** A daemon whose host broadcasts a notification just before it answers host/info with a signed-in account. */
async function chattyDaemon(directory: string) {
  const account = { userId: 'user-1', environmentUrl: 'https://app.example.com' };
  const host = {
    hostId: 'host-1',
    server: {
      connect: (notify: (notification: HostNotification) => void) => ({
        handle: async (request: HostRequest) => {
          notify({ jsonrpc: '2.0', method: 'host/stateChanged', params: { account } });
          return hostResult(request.id, {
            hostId: 'host-1',
            hostName: 'host',
            hostVersion: '1.2.3',
            protocol: { major: 1, minor: 0 },
            capabilities: [],
            platform: 'linux',
            homeDirectory: '/home/user',
            account,
          });
        },
        close: () => undefined,
      }),
    },
    dispose: () => undefined,
  } as unknown as HeadlessHost;
  daemons.push(
    await startDaemon({ dataDirectory: directory, version: '1.2.3', logger: logger(), compose: async () => host })
  );
  return account;
}

describePosix('readHostStatus', () => {
  it('reports not running without a lock', async () => {
    expect(await readHostStatus(await dataDirectory())).toEqual({ running: false });
  });

  it('reports not running for a lock left by a process that is gone', async () => {
    const directory = await dataDirectory();
    await writeLock(directory, { pid: deadPid(), version: '1.0.0', startedAt: Date.now() });

    expect(await readHostStatus(directory)).toEqual({ running: false });
  });

  it('reports a live daemon whose socket is not answering yet as starting', async () => {
    const directory = await dataDirectory();
    await writeLock(directory, { pid: process.pid, version: '1.0.0', startedAt: Date.now() });

    expect(await readHostStatus(directory)).toEqual({
      running: true,
      pid: process.pid,
      version: '1.0.0',
      starting: true,
      account: null,
    });
  });

  it('reports a running daemon with no account when host/info times out', async () => {
    const directory = await dataDirectory();
    const { handled } = await silentDaemon(directory);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const status = readHostStatus(directory);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledWith('host/info'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await status).toEqual({ running: true, pid: process.pid, version: '1.2.3', starting: false, account: null });
  });

  it('reads the host/info answer when a notification arrives ahead of it', async () => {
    const directory = await dataDirectory();
    const account = await chattyDaemon(directory);

    expect(await readHostStatus(directory)).toEqual({
      running: true,
      pid: process.pid,
      version: '1.2.3',
      starting: false,
      account,
    });
  });
});

describePosix('stopDaemon', () => {
  it('reports that no daemon is running and succeeds', async () => {
    const log = logger();

    expect(await stopDaemon(await dataDirectory(), log)).toBe(HOST_EXIT_CODES.ok);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no daemon is running'));
  });

  it('succeeds when the daemon exits before the signal reaches it', async () => {
    const directory = await dataDirectory();
    await writeLock(directory, { pid: process.pid, version: '1.0.0', startedAt: Date.now() });
    interceptSigterm(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    const log = logger();

    expect(await stopDaemon(directory, log)).toBe(HOST_EXIT_CODES.ok);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('rethrows any other failure to signal the daemon', async () => {
    const directory = await dataDirectory();
    await writeLock(directory, { pid: process.pid, version: '1.0.0', startedAt: Date.now() });
    interceptSigterm(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });

    await expect(stopDaemon(directory, logger())).rejects.toThrow('kill EPERM');
  });

  it('fails when the daemon is still alive after the stop timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const directory = await dataDirectory();
    // Dated ahead so the startup grace cannot lapse while the first inspection does real I/O.
    await writeLock(directory, { pid: process.pid, version: '1.0.0', startedAt: Date.now() + 60 * 60_000 });
    const sigterm = vi.fn();
    interceptSigterm(sigterm);
    const log = logger();

    let result: number | undefined;
    const stopping = stopDaemon(directory, log).then(code => (result = code));
    while (result === undefined) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise(resolve => setImmediate(resolve));
    }
    await stopping;

    expect(sigterm).toHaveBeenCalledOnce();
    expect(result).toBe(HOST_EXIT_CODES.failure);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('did not stop'));
  });
});
