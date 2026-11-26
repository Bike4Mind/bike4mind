import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeHeadlessHost, type HeadlessHost } from './composeHeadlessHost';
import { startDaemon, type RunningDaemon } from './daemon';
import { daemonPaths } from './daemonFiles';
import { runDaemonProcess } from './daemonProcess';
import { HOST_EXIT_CODES } from './exitCodes';

vi.mock('./composeHeadlessHost', () => ({ composeHeadlessHost: vi.fn() }));

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const SIGNAL_EVENTS = ['SIGTERM', 'SIGINT'];
const CRASH_EVENTS = ['unhandledRejection', 'uncaughtException'];
type Listener = (...args: unknown[]) => void;

const events = process as NodeJS.EventEmitter;
const listenersOf = (event: string) => events.listeners(event) as Listener[];
let heldSignalListeners = new Map<string, Listener[]>();
let baselineCrashListeners = new Map<string, Listener[]>();

// The runner's own signal handlers must not fire when a test emits a signal, and the listeners
// runDaemonProcess adds must not outlive the test.
beforeEach(() => {
  vi.mocked(composeHeadlessHost).mockReset();
  heldSignalListeners = new Map(SIGNAL_EVENTS.map(event => [event, listenersOf(event)]));
  for (const event of SIGNAL_EVENTS) events.removeAllListeners(event);
  baselineCrashListeners = new Map(CRASH_EVENTS.map(event => [event, listenersOf(event)]));
});

const daemons: RunningDaemon[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const event of SIGNAL_EVENTS) {
    events.removeAllListeners(event);
    for (const listener of heldSignalListeners.get(event) ?? []) events.on(event, listener);
  }
  for (const event of CRASH_EVENTS) {
    const baseline = baselineCrashListeners.get(event) ?? [];
    for (const listener of listenersOf(event)) {
      if (!baseline.includes(listener)) events.removeListener(event, listener);
    }
  }
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
  return join(root, 'host');
}

// The server answers nothing: a starter probing the socket connects to it and leaves.
const standInHost = () => ({
  hostId: 'host-1',
  server: { connect: () => ({ handle: () => new Promise(() => undefined), close: () => undefined }) },
  dispose: vi.fn(),
});

function run(directory: string) {
  return runDaemonProcess({ dataDirectory: directory, homeDirectory: '/home/user', version: '1.0.0', verbose: false });
}

const silenceStderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

describePosix('runDaemonProcess', () => {
  it('shuts down and exits ok when a signal arrives while the host is still composing', async () => {
    let finish!: (host: HeadlessHost) => void;
    vi.mocked(composeHeadlessHost).mockReturnValue(
      new Promise<HeadlessHost>(resolve => {
        finish = resolve;
      })
    );
    const directory = await dataDirectory();
    const paths = daemonPaths(directory);
    const host = standInHost();

    const running = run(directory);
    await vi.waitFor(() => expect(composeHeadlessHost).toHaveBeenCalledOnce());
    process.emit('SIGTERM', 'SIGTERM');
    finish(host as unknown as HeadlessHost);

    expect(await running).toBe(HOST_EXIT_CODES.ok);
    expect(host.dispose).toHaveBeenCalledOnce();
    await expect(stat(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits with the already-running code while another daemon holds the lock', async () => {
    const directory = await dataDirectory();
    daemons.push(
      await startDaemon({
        dataDirectory: directory,
        version: '0.9.0',
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        compose: async () => standInHost() as unknown as HeadlessHost,
      })
    );
    const stderr = silenceStderr();

    expect(await run(directory)).toBe(HOST_EXIT_CODES.daemonAlreadyRunning);
    expect(composeHeadlessHost).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('exits with the failure code and leaves no lock or socket when the host fails to compose', async () => {
    vi.mocked(composeHeadlessHost).mockRejectedValue(new Error('compose failed'));
    const directory = await dataDirectory();
    const paths = daemonPaths(directory);
    const stderr = silenceStderr();

    expect(await run(directory)).toBe(HOST_EXIT_CODES.failure);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('compose failed'));
    await expect(stat(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
