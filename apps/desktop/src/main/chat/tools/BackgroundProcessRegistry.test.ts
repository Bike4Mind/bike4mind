import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundProcessInfo } from '@shared/chat';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import type { OutputStream } from './outputBuffer';
import { resolveUserPath } from './userPath';

vi.mock('./userPath', () => ({ resolveUserPath: vi.fn(async () => process.env.PATH ?? '') }));

const run = promisify(execFile);

/** True while any process still has `marker` in its argv - how a leaked group is caught. */
async function isAlive(marker: string): Promise<boolean> {
  const { stdout } = await run('/bin/ps', ['-Ao', 'args']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').some(line => line.includes(marker) && !line.includes('ps -Ao') && !line.includes('grep'));
}

async function waitUntilGone(marker: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAlive(marker))) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * A child spawned the way the FOREGROUND runner spawns one: detached, with its output piped
 * and no watch pipe on fd 3. Adoption exists for exactly this process, so a test that handed
 * the registry one of its own spawns would be testing nothing.
 */
function spawnForeground(command: string, cwd: string) {
  const child = spawn('/bin/bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const captured: { stream: OutputStream; text: string }[] = [];
  const onData = (chunk: Buffer) => captured.push({ stream: 'stdout', text: chunk.toString('utf8') });
  child.stdout?.on('data', onData);

  return {
    child,
    /** Resolves once `text` has been printed, so the handover is tested with something in hand. */
    printed: (text: string) =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`never printed ${text}`)), 8_000);
        const check = () => {
          if (!captured.some(chunk => chunk.text.includes(text))) return;
          clearTimeout(deadline);
          child.stdout?.off('data', check);
          resolve();
        };
        child.stdout?.on('data', check);
        check();
      }),
    /** What the foreground runner hands over: the pipes are the registry's from here on. */
    handover: () => {
      child.stdout?.off('data', onData);
      return {
        child,
        pgid: child.pid ?? null,
        startedAt: new Date().toISOString(),
        launch: noLaunch(),
        captured: [...captured],
      };
    },
  };
}

/** The sandbox is off for shell commands, so a real launch has nothing to clean up either. */
function noLaunch() {
  return { executable: '/bin/bash', args: [] as string[], cleanup: async () => undefined };
}

/**
 * These start REAL processes and then check with `ps` that they are
 * actually gone. That is the whole point: a mocked spawn would assert we called kill, and the
 * failure this feature exists to prevent is a process group that survives the call.
 */
describe('BackgroundProcessRegistry', () => {
  let root: string;
  let registry: BackgroundProcessRegistry;
  let statuses: BackgroundProcessInfo[];
  let output: string[];

  const start = (command: string, sessionId = 'session-a') =>
    registry.start({ sessionId, command, cwd: root, roots: [root], protectedPaths: [] });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-bg-')));
    statuses = [];
    output = [];
    registry = new BackgroundProcessRegistry({
      output: (_sessionId, _processId, _stream, text) => output.push(text),
      status: (_sessionId, info) => statuses.push(info),
    });
  });

  afterEach(async () => {
    await registry.shutdown();
    registry.shutdownSync();
  });

  it('returns a handle while the command is still running, and streams its output', async () => {
    const marker = `b4m-marker-${Date.now()}`;
    const info = await start(`echo ${marker}; sleep 20`);

    expect(info.status).toBe('running');
    await registry.settle(info.id, 1_500);

    const read = registry.readForModel(info.id, 'session-a', 5_000);
    expect(read?.text).toContain(marker);
    expect(read?.info.status).toBe('running');
    expect(output.join('')).toContain(marker);
  }, 20_000);

  it('runs outside the granted roots with the PATH from the user shell', async () => {
    vi.mocked(resolveUserPath).mockResolvedValueOnce('/b4m-test/bin:/usr/bin:/bin');
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-bg-outside-')));
    try {
      const info = await start(`echo "path=$PATH"; echo wrote > ${join(outside, 'out.txt')}`);
      await registry.settle(info.id, 3_000);
      const read = registry.readForModel(info.id, 'session-a', 5_000);
      expect(read?.text).toContain('path=/b4m-test/bin:/usr/bin:/bin');
      expect(read?.info.status).toBe('exited');
      await expect(readFile(join(outside, 'out.txt'), 'utf8')).resolves.toContain('wrote');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 20_000);

  it('hands the model only new output on a second read', async () => {
    const info = await start('echo one; sleep 0.4; echo two; sleep 20');
    await registry.settle(info.id, 1_500);

    const first = registry.readForModel(info.id, 'session-a', 5_000);
    expect(first?.text).toContain('one');
    expect(first?.text).toContain('two');
    expect(registry.readForModel(info.id, 'session-a', 5_000)?.text).toBe('');
  }, 20_000);

  it('reports a command that dies immediately as finished, not as a live handle', async () => {
    const info = await start('echo starting; exit 7');
    await registry.settle(info.id, 3_000);

    const read = registry.readForModel(info.id, 'session-a', 5_000);
    expect(read?.info.status).toBe('exited');
    expect(read?.info.exitCode).toBe(7);
  }, 20_000);

  /** The reason signals go to -pgid: a bare pid leaves the command's children running. */
  it('kills the whole process group, not just the command it spawned', async () => {
    const marker = `b4m-child-${Date.now()}`;
    const info = await start(`sh -c 'sleep 60 # ${marker}' & sleep 60`);

    await registry.settle(info.id, 1_000);
    expect(await isAlive(marker)).toBe(true);

    await registry.kill(info.id, 'session-a');

    expect(await waitUntilGone(marker)).toBe(true);
    expect(registry.get(info.id, 'session-a')?.status).toBe('killed');
  }, 30_000);

  /**
   * The Stop button's real failure mode, and the reason it looked broken.
   *
   * Node reports 'close' only once EVERY holder of the child's pipes has let go, and a
   * descendant that escaped the process group is still a holder. The command itself has ended
   * - 'exit' fired - but waiting on 'close' meant the record never finished, no status event
   * went out, and the panel showed the task under Running with its clock ticking for the rest
   * of the app's life.
   */
  it('reports a stopped command as stopped even when a descendant holds its output pipe open', async () => {
    const pidFile = join(root, 'escapee.pid');
    // setpgrp puts the descendant in a group of its own, so the group signal never reaches it,
    // and it keeps the stdout it inherited.
    const info = await start(`perl -e 'setpgrp; open(F,">","${pidFile}"); print F $$; close F; sleep 60;' & sleep 60`);
    await registry.settle(info.id, 1_500);
    const escapee = Number((await readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(escapee)).toBe(true);

    // Raced rather than awaited: before the fix this never resolves, and a hung await would
    // report as a timeout rather than as the assertion below.
    await Promise.race([registry.kill(info.id, 'session-a'), new Promise(resolve => setTimeout(resolve, 8_000))]);

    expect(statuses.filter(entry => entry.id === info.id).map(entry => entry.status)).toEqual(['running', 'killed']);
    expect(registry.get(info.id, 'session-a')?.status).toBe('killed');
    expect(registry.get(info.id, 'session-a')?.endedAt).toBeTruthy();

    // A process that left its group is beyond a group signal; it is still not ours to leak.
    try {
      process.kill(escapee, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 30_000);

  it('kills everything on shutdown, which is what app quit calls', async () => {
    const marker = `b4m-quit-${Date.now()}`;
    await start(`sleep 60 # ${marker}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await isAlive(marker)).toBe(true);

    await registry.shutdown();

    expect(await waitUntilGone(marker)).toBe(true);
  }, 30_000);

  it('takes a deleted conversation processes with it', async () => {
    const marker = `b4m-session-${Date.now()}`;
    await start(`sleep 60 # ${marker}`, 'doomed');
    await new Promise(resolve => setTimeout(resolve, 500));

    await registry.killSession('doomed');

    expect(await waitUntilGone(marker)).toBe(true);
    expect(registry.list('doomed')).toHaveLength(0);
  }, 30_000);

  it('will not let one conversation read or stop another process', async () => {
    const info = await start('sleep 20', 'session-a');

    expect(registry.get(info.id, 'session-b')).toBeNull();
    expect(registry.readForModel(info.id, 'session-b', 1_000)).toBeNull();
    await expect(registry.kill(info.id, 'session-b')).resolves.toBeNull();
    expect(registry.get(info.id, 'session-a')?.status).toBe('running');
  }, 20_000);

  it('refuses to accumulate background processes without limit', async () => {
    for (let i = 0; i < 5; i++) await start('sleep 20');
    await expect(start('sleep 20')).rejects.toThrow(/already has 5 background commands/);
  }, 30_000);

  it('announces every status change so the UI can follow without polling', async () => {
    const info = await start('echo done');
    await registry.settle(info.id, 3_000);

    expect(statuses.filter(entry => entry.id === info.id).map(entry => entry.status)).toEqual(['running', 'exited']);
  }, 20_000);

  describe('adopting a command already running in the foreground', () => {
    /** Stray children of a failed adoption; the registry never took responsibility for them. */
    let orphans: ChildProcess[];

    beforeEach(() => {
      orphans = [];
    });

    afterEach(() => {
      for (const child of orphans) {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    });

    it('registers the process and keeps what it printed before the move', async () => {
      const marker = `b4m-adopt-${Date.now()}`;
      const running = spawnForeground(`echo ${marker}; sleep 20`, root);
      orphans.push(running.child);
      await running.printed(marker);

      const handover = running.handover();
      const info = registry.adopt({
        sessionId: 'session-a',
        command: `echo ${marker}; sleep 20`,
        cwd: root,
        ...handover,
      });

      expect(info.status).toBe('running');
      // Not the moment of the move: the panel counts elapsed time from here, and a clock that
      // restarted would under-report a build that had already been going for ten minutes.
      expect(info.startedAt).toBe(handover.startedAt);
      expect(registry.list('session-a').map(entry => entry.id)).toContain(info.id);
      expect(statuses.map(entry => entry.status)).toContain('running');

      // The whole point of carrying the capture across: the model never saw this output, because
      // the call it belonged to never returned.
      expect(registry.readForModel(info.id, 'session-a', 5_000)?.text).toContain(marker);
    }, 30_000);

    it('counts an adopted process against the same cap as one it started', async () => {
      for (let i = 0; i < 5; i++) await start('sleep 20');

      const running = spawnForeground('sleep 20', root);
      orphans.push(running.child);

      expect(() =>
        registry.adopt({ sessionId: 'session-a', command: 'sleep 20', cwd: root, ...running.handover() })
      ).toThrow(/already has 5 background commands/);
      expect(registry.list('session-a')).toHaveLength(5);
    }, 30_000);

    it('signals an adopted process group, not just the command it was handed', async () => {
      const marker = `b4m-adopt-group-${Date.now()}`;
      const command = `sh -c 'sleep 60 # ${marker}' & sleep 60`;
      const running = spawnForeground(command, root);
      orphans.push(running.child);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await isAlive(marker)).toBe(true);

      const info = registry.adopt({ sessionId: 'session-a', command, cwd: root, ...running.handover() });
      await registry.kill(info.id, 'session-a');

      expect(await waitUntilGone(marker)).toBe(true);
      expect(registry.get(info.id, 'session-a')?.status).toBe('killed');
    }, 30_000);

    it('reports an adopted process finishing like any other', async () => {
      const running = spawnForeground('sleep 0.2; exit 4', root);
      orphans.push(running.child);

      const info = registry.adopt({
        sessionId: 'session-a',
        command: 'sleep 0.2; exit 4',
        cwd: root,
        ...running.handover(),
      });
      await registry.settle(info.id, 5_000);

      expect(registry.get(info.id, 'session-a')?.status).toBe('exited');
      expect(registry.get(info.id, 'session-a')?.exitCode).toBe(4);
    }, 20_000);
  });
});
