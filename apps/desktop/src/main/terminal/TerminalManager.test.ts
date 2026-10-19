import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { MAX_TERMINALS_PER_SESSION, type TerminalInfo } from '@shared/terminal';
import {
  defaultShell,
  REPLAY_CHARS,
  TerminalManager,
  terminalEnv,
  type PtyProcess,
  type PtySpawnOptions,
  type TerminalReceiver,
} from './TerminalManager';

class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  sizes: [number, number][] = [];
  signals: (string | undefined)[] = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: PtySpawnOptions
  ) {}

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill(signal?: string) {
    this.signals.push(signal);
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number, signal?: number) {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal });
  }
}

function receiver(id: number) {
  const sent: { channel: string; payload: { terminalId: string; data: string } }[] = [];
  let destroyed = false;
  const target: TerminalReceiver = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push({ channel, payload: payload as { terminalId: string; data: string } }),
  };
  return { target, sent, destroy: () => (destroyed = true) };
}

let ptys: FakePty[];
let changes: { sessionId: string; terminals: TerminalInfo[] }[];
let projectDir: string;
let cwdFor: Record<string, string | null>;

function manager(overrides: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  return new TerminalManager({
    loadSpawn: async () => (file, args, options) => {
      const pty = new FakePty(file, args, options);
      ptys.push(pty);
      return pty;
    },
    workingDirectory: async sessionId => cwdFor[sessionId] ?? null,
    userPath: async () => '/login/shell/bin:/usr/bin',
    home: '/home/someone',
    shell: { file: '/bin/zsh', args: ['-l'] },
    baseEnv: { HOME: '/home/someone', ELECTRON_RUN_AS_NODE: '1', LANG: 'en_GB.UTF-8' },
    platform: 'darwin',
    changed: (sessionId, terminals) => changes.push({ sessionId, terminals }),
    ...overrides,
  });
}

async function open(terminals: TerminalManager, sessionId = 's1') {
  const result = await terminals.create(sessionId, 100, 30);
  if (!result.ok) throw new Error(result.error);
  return { info: result.terminal, pty: ptys[ptys.length - 1] };
}

beforeEach(() => {
  ptys = [];
  changes = [];
  projectDir = mkdtempSync(join(tmpdir(), 'b4m-terminal-'));
  cwdFor = { s1: projectDir };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('spawning', () => {
  it('starts the login shell in the session working directory with the login PATH', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);

    expect(pty.file).toBe('/bin/zsh');
    expect(pty.args).toEqual(['-l']);
    expect(pty.options).toMatchObject({ cwd: projectDir, cols: 100, rows: 30, name: 'xterm-256color' });
    expect(pty.options.env.PATH).toBe('/login/shell/bin:/usr/bin');
    expect(pty.options.env.TERM).toBe('xterm-256color');
    expect(pty.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(pty.options.env.SHELL).toBe('/bin/zsh');
    expect(info).toMatchObject({ sessionId: 's1', title: 'zsh', cwd: projectDir, generation: 0, exit: null });
    expect(changes.at(-1)).toEqual({ sessionId: 's1', terminals: [info] });
  });

  it('opens at home when the session has no folder, or its folder is gone', async () => {
    cwdFor = { s1: null, s2: join(projectDir, 'removed-worktree') };
    const terminals = manager();
    expect((await open(terminals, 's1')).pty.options.cwd).toBe('/home/someone');
    expect((await open(terminals, 's2')).pty.options.cwd).toBe('/home/someone');
  });

  it('loads the native module once, on the first terminal and not before', async () => {
    const load = vi.fn(async () => (file: string, args: string[], options: PtySpawnOptions) => {
      const pty = new FakePty(file, args, options);
      ptys.push(pty);
      return pty;
    });
    const terminals = manager({ loadSpawn: load });
    expect(load).not.toHaveBeenCalled();
    await open(terminals);
    await open(terminals);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refuses a terminal past the per-session cap without spawning', async () => {
    const terminals = manager();
    for (let i = 0; i < MAX_TERMINALS_PER_SESSION; i++) await open(terminals);
    const refused = await terminals.create('s1', 80, 24);
    expect(refused.ok).toBe(false);
    expect(ptys).toHaveLength(MAX_TERMINALS_PER_SESSION);
  });

  it('reports a spawn failure instead of throwing', async () => {
    const terminals = manager({
      loadSpawn: async () => () => {
        throw new Error('posix_spawnp failed.');
      },
    });
    const result = await terminals.create('s1', 80, 24);
    expect(result).toEqual({ ok: false, error: 'Could not start a shell: posix_spawnp failed.' });
    expect(terminals.list('s1')).toEqual([]);
  });
});

describe('input and resize', () => {
  it('writes input to the pty and clamps resizes', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);
    terminals.write(info.id, 'ls\r');
    terminals.write(info.id, 42);
    terminals.resize(info.id, 132.7, 0);
    terminals.resize(info.id, Number.NaN, 5_000);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.sizes).toEqual([
      [132, 2],
      [132, 1_000],
    ]);
  });
});

describe('output batching', () => {
  it('coalesces output into one push per frame, only to attached windows', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const { info, pty } = await open(terminals);
    const watching = receiver(1);
    const other = receiver(2);
    terminals.attach(watching.target, info.id);

    for (const char of 'hello') pty.emit(char);
    expect(watching.sent).toEqual([]);
    vi.advanceTimersByTime(16);

    expect(watching.sent).toEqual([
      { channel: IPC_CHANNELS.terminalData, payload: { terminalId: info.id, data: 'hello' } },
    ]);
    expect(other.sent).toEqual([]);
  });

  it('flushes a large burst at once rather than waiting out the frame', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const { info, pty } = await open(terminals);
    const watching = receiver(1);
    terminals.attach(watching.target, info.id);
    pty.emit('x'.repeat(300 * 1024));
    expect(watching.sent).toHaveLength(1);
  });

  it('sends nothing while no window is attached, and replays it on attach', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const { info, pty } = await open(terminals);
    pty.emit('before\r\n');
    vi.advanceTimersByTime(100);

    const late = receiver(1);
    expect(terminals.attach(late.target, info.id)).toEqual({ terminal: info, replay: 'before\r\n' });
    pty.emit('after');
    vi.advanceTimersByTime(16);
    expect(late.sent.map(entry => entry.payload.data)).toEqual(['after']);
  });

  it('gives a second window a replay that does not overlap what the first is about to be sent', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const { info, pty } = await open(terminals);
    const first = receiver(1);
    terminals.attach(first.target, info.id);
    pty.emit('pending');

    const second = receiver(2);
    expect(terminals.attach(second.target, info.id)?.replay).toBe('pending');
    vi.advanceTimersByTime(16);
    expect(first.sent.map(entry => entry.payload.data)).toEqual(['pending']);
    expect(second.sent).toEqual([]);
  });

  it('caps the replay and starts it on a whole line once trimmed', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);
    const line = `${'y'.repeat(99)}\n`;
    for (let i = 0; i < (REPLAY_CHARS / line.length) * 2; i++) pty.emit(line);
    pty.emit('tail');
    const replay = terminals.attach(receiver(1).target, info.id)?.replay ?? '';
    expect(replay.length).toBeLessThanOrEqual(REPLAY_CHARS);
    expect(replay.startsWith('y'.repeat(99))).toBe(true);
    expect(replay.endsWith('tail')).toBe(true);
  });

  it('drops a destroyed window and stops sending to a detached one', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const { info, pty } = await open(terminals);
    const gone = receiver(1);
    const leaving = receiver(2);
    terminals.attach(gone.target, info.id);
    terminals.attach(leaving.target, info.id);
    gone.destroy();
    terminals.detach(2, info.id);
    pty.emit('data');
    vi.advanceTimersByTime(16);
    expect(gone.sent).toEqual([]);
    expect(leaving.sent).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('records an exit and announces it, keeping the tab', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);
    pty.exit(130);
    expect(terminals.list('s1')).toEqual([{ ...info, exit: { code: 130, signal: null } }]);
    expect(changes.at(-1)?.terminals[0].exit).toEqual({ code: 130, signal: null });
    terminals.write(info.id, 'ignored');
    expect(pty.written).toEqual([]);
  });

  it('restarts in the same tab with a new generation and an empty replay', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);
    pty.emit('old output');
    const next = await terminals.restart(info.id);
    expect(pty.signals).toEqual(['SIGHUP']);
    expect(ptys).toHaveLength(2);
    expect(next).toMatchObject({ id: info.id, generation: 1, exit: null });
    expect(terminals.attach(receiver(1).target, info.id)?.replay).toBe('');
    // The old shell's late exit must not mark the new one as ended.
    pty.exit(0);
    expect(terminals.list('s1')[0].exit).toBeNull();
  });

  it('closes a tab by hanging up on its shell', async () => {
    const terminals = manager();
    const { info, pty } = await open(terminals);
    terminals.close(info.id);
    expect(pty.signals).toEqual(['SIGHUP']);
    expect(terminals.list('s1')).toEqual([]);
    expect(changes.at(-1)).toEqual({ sessionId: 's1', terminals: [] });
  });

  it('kills only the closed session terminals', async () => {
    cwdFor.s2 = projectDir;
    const terminals = manager();
    const a = await open(terminals, 's1');
    const b = await open(terminals, 's1');
    const other = await open(terminals, 's2');
    terminals.killSession('s1');
    expect(a.pty.signals).toEqual(['SIGHUP']);
    expect(b.pty.signals).toEqual(['SIGHUP']);
    expect(other.pty.signals).toEqual([]);
    expect(terminals.list('s1')).toEqual([]);
    expect(terminals.list('s2')).toHaveLength(1);
  });

  it('hangs up at quit, and kills by pid only what is still running after the grace', async () => {
    vi.useFakeTimers();
    const terminals = manager();
    const polite = await open(terminals);
    const stubborn = await open(terminals);
    const done = terminals.shutdown();
    polite.pty.exit(0, 1);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(polite.pty.signals).toEqual(['SIGHUP']);
    expect(stubborn.pty.signals).toEqual(['SIGHUP', 'SIGKILL']);
  });

  it('shuts down synchronously with a hangup to every running shell', async () => {
    const terminals = manager();
    const running = await open(terminals);
    const exited = await open(terminals);
    exited.pty.exit(0);
    terminals.shutdownSync();
    expect(running.pty.signals).toEqual(['SIGHUP']);
    expect(exited.pty.signals).toEqual([]);
  });

  it('never names a signal on Windows, where node-pty refuses one', async () => {
    const terminals = manager({ platform: 'win32' });
    const { info, pty } = await open(terminals);
    terminals.close(info.id);
    expect(pty.signals).toEqual([undefined]);
  });
});

describe('races with a start in flight', () => {
  /** A login-PATH lookup held open, so a start is parked between its checks and its spawn. */
  function heldPath() {
    const waiting: (() => void)[] = [];
    let released = false;
    return {
      userPath: () =>
        released ? Promise.resolve('/bin') : new Promise<string>(resolve => waiting.push(() => resolve('/bin'))),
      release: async () => {
        released = true;
        for (const resolve of waiting.splice(0)) resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
      },
    };
  }

  const running = () => ptys.filter(pty => pty.signals.length === 0);

  it('does not leave a shell behind for a session closed while it was starting', async () => {
    const path = heldPath();
    const terminals = manager({ userPath: path.userPath });
    const created = terminals.create('s1', 80, 24);
    await new Promise(resolve => setTimeout(resolve, 0));
    terminals.killSession('s1');
    await path.release();
    expect((await created).ok).toBe(false);
    expect(terminals.list('s1')).toEqual([]);
    expect(running()).toEqual([]);
  });

  it('keeps one shell when restart is pressed twice before the first one starts', async () => {
    const terminals = manager();
    const { info } = await open(terminals);
    const path = heldPath();
    // Swap in the held lookup for the restarts only.
    (terminals as unknown as { deps: { userPath: () => Promise<string> } }).deps.userPath = path.userPath;
    const first = terminals.restart(info.id);
    const second = terminals.restart(info.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    await path.release();
    await Promise.all([first, second]);
    expect(running()).toHaveLength(1);
    expect(terminals.list('s1')[0].exit).toBeNull();
  });

  it('does not start a shell for a tab closed while it was restarting', async () => {
    const terminals = manager();
    const { info } = await open(terminals);
    const path = heldPath();
    (terminals as unknown as { deps: { userPath: () => Promise<string> } }).deps.userPath = path.userPath;
    const restarting = terminals.restart(info.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    terminals.close(info.id);
    await path.release();
    await restarting;
    expect(running()).toEqual([]);
    expect(terminals.list('s1')).toEqual([]);
  });

  it('holds the per-session cap against creates that overlap', async () => {
    const path = heldPath();
    const terminals = manager({ userPath: path.userPath });
    const all = Array.from({ length: MAX_TERMINALS_PER_SESSION + 2 }, () => terminals.create('s1', 80, 24));
    await new Promise(resolve => setTimeout(resolve, 0));
    await path.release();
    const results = await Promise.all(all);
    expect(results.filter(result => result.ok)).toHaveLength(MAX_TERMINALS_PER_SESSION);
    expect(running()).toHaveLength(MAX_TERMINALS_PER_SESSION);
  });
});

describe('defaults', () => {
  it('uses $SHELL as a login shell, then the account shell, then zsh', () => {
    expect(defaultShell('darwin', { SHELL: '/opt/fish' }, '/bin/bash')).toEqual({ file: '/opt/fish', args: ['-l'] });
    expect(defaultShell('darwin', {}, '/bin/bash')).toEqual({ file: '/bin/bash', args: ['-l'] });
    expect(defaultShell('darwin', {}, null)).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(defaultShell('win32', {}, null).args).toEqual([]);
  });

  it('fills LANG from the app locale only when the environment has none', () => {
    expect(terminalEnv({}, '/bin', 'fr-FR').LANG).toBe('fr_FR.UTF-8');
    expect(terminalEnv({}, '/bin', 'zh-Hans').LANG).toBe('en_US.UTF-8');
    expect(terminalEnv({ LANG: 'de_DE.UTF-8' }, '/bin', 'fr-FR').LANG).toBe('de_DE.UTF-8');
  });
});
