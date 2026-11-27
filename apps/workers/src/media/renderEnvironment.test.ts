import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fsMocks = vi.hoisted(() => ({ rm: vi.fn(), actualRm: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.actualRm.mockImplementation(actual.rm);
  return { ...actual, rm: fsMocks.rm };
});

import {
  createRenderEnvironment,
  parseProcStat,
  procfsProcessTable,
  RenderDeadlineError,
  RenderEnvironmentError,
  strayProcesses,
  type ProcessEntry,
  type RenderWorkspace,
} from './renderEnvironment';

const SELF = 100;
const proc = (pid: number, ppid: number, name = 'proc', extra: Partial<ProcessEntry> = {}): ProcessEntry => ({
  pid,
  ppid,
  state: 'S',
  name,
  kernelThread: false,
  ...extra,
});

/** An in-memory process table; kill removes the process unless it is listed as unkillable. */
function fakeProcesses(initial: ProcessEntry[], { unkillable = [] as number[] } = {}) {
  const live = new Map(initial.map(entry => [entry.pid, entry]));
  return {
    spawn: (entry: ProcessEntry) => void live.set(entry.pid, entry),
    table: {
      list: vi.fn(async () => [...live.values()]),
      kill: vi.fn((pid: number) => {
        if (!unkillable.includes(pid)) live.delete(pid);
      }),
    },
  };
}

const platform = () => [proc(1, 0, 'init'), proc(SELF, 1, 'node')];
/** Lambda's shape: init is not among the runtime's ancestors (modelled as the runtime's PPID reading 0). */
const lambdaPlatform = () => [proc(1, 0, 'init'), proc(SELF, 0, 'node')];

let scratchRoot: string;
beforeEach(() => {
  scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'render-env-test-'));
  fsMocks.rm.mockImplementation(fsMocks.actualRm);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const environmentWith = (table: ReturnType<typeof fakeProcesses>['table'], killTimeoutMs = 1_000) =>
  createRenderEnvironment({ scratchRoot, processes: table, selfPid: SELF, killTimeoutMs });

describe('createRenderEnvironment', () => {
  it('empties the scratch directory first and hands the render a fresh, private workspace', async () => {
    writeFileSync(path.join(scratchRoot, 'chromium'), 'left from an earlier render');
    mkdirSync(path.join(scratchRoot, 'thumbnail-render-old', 'profile'), { recursive: true });
    writeFileSync(path.join(scratchRoot, 'thumbnail-render-old', 'profile', 'Cookies'), 'old');
    const { table } = fakeProcesses(platform());

    let seen: RenderWorkspace | undefined;
    const result = await environmentWith(table).run(async workspace => {
      seen = workspace;
      expect(readdirSync(scratchRoot)).toHaveLength(1);
      for (const dir of [workspace.userDataDir, workspace.tmpDir]) {
        expect(path.dirname(path.dirname(dir))).toBe(scratchRoot);
        expect(readdirSync(dir)).toEqual([]);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(workspace.userDataDir).not.toBe(workspace.tmpDir);
      writeFileSync(path.join(workspace.tmpDir, 'scratch'), 'render output');
      return 'rendered';
    });

    expect(result).toBe('rendered');
    expect(seen).toBeDefined();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it('gives every render a workspace of its own', async () => {
    const environment = environmentWith(fakeProcesses(platform()).table);
    const first = await environment.run(async workspace => workspace);
    const second = await environment.run(async workspace => workspace);
    expect(second.userDataDir).not.toBe(first.userDataDir);
    expect(existsSync(first.userDataDir)).toBe(false);
  });

  it("kills the render's own process tree by PID once it ends, then releases the result", async () => {
    const processes = fakeProcesses(platform());
    const result = await environmentWith(processes.table).run(async () => {
      processes.spawn(proc(200, SELF, 'chromium'));
      processes.spawn(proc(201, 200, 'chromium-helper'));
      return 'rendered';
    });

    expect(result).toBe('rendered');
    const killed = processes.table.kill.mock.calls.map(([pid]) => pid);
    expect(killed.sort()).toEqual([200, 201]);
    expect(await processes.table.list()).toEqual(platform());
  });

  it('allows its own ancestors and ignores kernel threads and exited processes', async () => {
    const { table } = fakeProcesses([
      proc(1, 0, 'init'),
      proc(2, 0, 'kthreadd', { kernelThread: true }),
      proc(50, 1, 'bootstrap'),
      proc(SELF, 50, 'node'),
      proc(300, 1, 'defunct', { state: 'Z' }),
    ]);
    await expect(environmentWith(table).run(async () => 'rendered')).resolves.toBe('rendered');
    expect(table.kill).not.toHaveBeenCalled();
  });

  it("allows the sandbox's init when it is not an ancestor of the runtime, as on Lambda", async () => {
    const processes = fakeProcesses(lambdaPlatform());
    const result = await environmentWith(processes.table).run(async () => {
      processes.spawn(proc(200, SELF, 'chromium'));
      return 'rendered';
    });

    expect(result).toBe('rendered');
    expect(processes.table.kill.mock.calls).toEqual([[200]]);
    expect(await processes.table.list()).toEqual(lambdaPlatform());
  });

  it('still refuses a process reparented to init beside a Lambda-shaped runtime, and never signals it', async () => {
    const { table } = fakeProcesses([...lambdaPlatform(), proc(400, 1, 'leftover')]);
    const render = vi.fn(async () => 'rendered');

    await expect(environmentWith(table).run(render)).rejects.toThrow(/unexpected processes \[400 leftover\]$/);
    expect(render).not.toHaveBeenCalled();
    expect(table.kill).not.toHaveBeenCalled();
  });

  it('withholds the result when a render leaves a process reparented to init on Lambda, signalling neither', async () => {
    const processes = fakeProcesses(lambdaPlatform());
    const failed = environmentWith(processes.table).run(async () => {
      processes.spawn(proc(200, SELF, 'chromium'));
      processes.spawn(proc(500, 1, 'reparented'));
      return 'rendered';
    });

    await expect(failed).rejects.toThrow(/unexpected processes \[500 reparented\]$/);
    expect(processes.table.kill.mock.calls).toEqual([[200]]);
    expect(console.error).toHaveBeenCalledWith(
      'publish thumbnail render process table (self 100): [1 0 S init, 100 0 S node, 500 1 S reparented]'
    );
  });

  it('logs the whole process table it saw, as pid, ppid, state and name only, when the check fails', async () => {
    const { table } = fakeProcesses([
      ...lambdaPlatform(),
      proc(2, 0, 'kthreadd', { kernelThread: true }),
      proc(300, 1, 'defunct', { state: 'Z' }),
      proc(400, 1, 'evil name\n/tmp/(x) and more'),
      proc(401, 1, 'odd', { state: 'S (sleeping)' }),
    ]);

    await expect(environmentWith(table).run(async () => 'rendered')).rejects.toThrow(/unexpected processes/);
    expect(console.error).toHaveBeenCalledWith(
      'publish thumbnail render process table (self 100): ' +
        '[1 0 S init, 100 0 S node, 2 0 S kthreadd, 300 1 Z defunct, 400 1 S evil?name??tmp??, 401 1 S odd]'
    );
  });

  it('logs nothing when the checks pass', async () => {
    const processes = fakeProcesses(lambdaPlatform());
    await environmentWith(processes.table).run(async () => {
      processes.spawn(proc(200, SELF, 'chromium'));
      return 'rendered';
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('refuses to start beside a process that is not part of this runtime, and never signals it', async () => {
    const { table } = fakeProcesses([...platform(), proc(400, 1, 'leftover')]);
    const render = vi.fn(async () => 'rendered');
    writeFileSync(path.join(scratchRoot, 'kept'), 'not deleted');

    await expect(environmentWith(table).run(render)).rejects.toThrow(/unexpected processes \[400 leftover\]/);
    expect(render).not.toHaveBeenCalled();
    expect(table.kill).not.toHaveBeenCalled();
    // The process check runs first, so a shared host (e.g. `sst dev`) never has its scratch root emptied.
    expect(readdirSync(scratchRoot)).toEqual(['kept']);
  });

  it('withholds the result when a process leaves the tree during the render, and stays poisoned', async () => {
    const processes = fakeProcesses(platform());
    const environment = environmentWith(processes.table);

    const failed = environment.run(async () => {
      processes.spawn(proc(500, 1, 'reparented'));
      return 'rendered';
    });
    await expect(failed).rejects.toBeInstanceOf(RenderEnvironmentError);
    await expect(failed).rejects.toThrow(/unexpected processes \[500 reparented\]/);
    expect(processes.table.kill).not.toHaveBeenCalledWith(500);
    expect(readdirSync(scratchRoot)).toEqual([]);

    const render = vi.fn(async () => 'rendered');
    await expect(environment.run(render)).rejects.toThrow(/already failed a check/);
    expect(render).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('500 reparented'));
  });

  it('fails closed when a render process survives SIGKILL', async () => {
    const processes = fakeProcesses(platform(), { unkillable: [200] });
    const environment = environmentWith(processes.table, 100);

    await expect(
      environment.run(async () => {
        processes.spawn(proc(200, SELF, 'chromium'));
        return 'rendered';
      })
    ).rejects.toThrow(/survived SIGKILL \[200 chromium\]/);
    expect(processes.table.kill).toHaveBeenCalledWith(200);
    await expect(environment.run(async () => 'rendered')).rejects.toBeInstanceOf(RenderEnvironmentError);
  });

  it('fails closed when the process table cannot be read or does not list this runtime', async () => {
    const unreadable = fakeProcesses(platform()).table;
    unreadable.list.mockRejectedValue(new Error('EACCES: /proc'));
    writeFileSync(path.join(scratchRoot, 'kept'), 'not deleted');
    await expect(environmentWith(unreadable).run(async () => 'rendered')).rejects.toThrow(/check failed: EACCES/);
    expect(readdirSync(scratchRoot)).toEqual(['kept']);

    const { table } = fakeProcesses([proc(1, 0, 'init')]);
    await expect(environmentWith(table).run(async () => 'rendered')).rejects.toThrow(/does not list this runtime/);
    expect(console.error).toHaveBeenCalledWith('publish thumbnail render process table (self 100): [1 0 S init]');
  });

  it('fails closed when the scratch directory cannot be emptied', async () => {
    const { table } = fakeProcesses(platform());
    const environment = environmentWith(table);
    fsMocks.rm.mockImplementation(async (target: string) => {
      if (path.basename(target).startsWith('stuck')) return;
      rmSync(target, { recursive: true, force: true });
    });

    await expect(
      environment.run(async workspace => {
        writeFileSync(path.join(scratchRoot, 'stuck-file'), 'cannot be removed');
        return workspace;
      })
    ).rejects.toThrow(/could not empty the scratch directory \(1 entries left\)/);
    await expect(environment.run(async () => 'rendered')).rejects.toThrow(/already failed a check/);
  });

  it("rethrows the render's own error after a clean teardown, without poisoning", async () => {
    const processes = fakeProcesses(platform());
    const environment = environmentWith(processes.table);

    await expect(
      environment.run(async () => {
        processes.spawn(proc(200, SELF, 'chromium'));
        throw new Error('Failed to launch the browser process');
      })
    ).rejects.toThrow('Failed to launch the browser process');
    expect(processes.table.kill).toHaveBeenCalledWith(200);
    expect(readdirSync(scratchRoot)).toEqual([]);
    await expect(environment.run(async () => 'rendered')).resolves.toBe('rendered');
  });

  it('stops waiting for a render at the deadline, still kills its processes, and stays usable', async () => {
    const processes = fakeProcesses(platform());
    const environment = environmentWith(processes.table, 1_000);
    // The teardown keeps its kill timeout plus a fixed margin; this leaves the render about 50 ms.
    const deadline = Date.now() + 1_000 + 3_000 + 50;

    const overrun = environment.run(
      async () => {
        processes.spawn(proc(200, SELF, 'chromium'));
        return new Promise<string>(() => undefined);
      },
      { deadline }
    );

    await expect(overrun).rejects.toBeInstanceOf(RenderDeadlineError);
    expect(processes.table.kill).toHaveBeenCalledWith(200);
    expect(await processes.table.list()).toEqual(platform());
    expect(readdirSync(scratchRoot)).toEqual([]);
    await expect(environment.run(async () => 'rendered', { deadline: Date.now() + 60_000 })).resolves.toBe('rendered');
  });

  it('refuses a second render while one is running', async () => {
    const environment = environmentWith(fakeProcesses(platform()).table);
    let release: () => void = () => undefined;
    const first = environment.run(() => new Promise<string>(resolve => (release = () => resolve('first'))));

    await expect(environment.run(async () => 'second')).rejects.toThrow(/already running/);
    await vi.waitFor(() => expect(readdirSync(scratchRoot)).toHaveLength(1));
    release();
    await expect(first).resolves.toBe('first');
  });
});

describe('strayProcesses', () => {
  it('allows PID 1 by PID, not by name, and nothing else beside the runtime', () => {
    const entries = [...lambdaPlatform(), proc(7, 0, 'init'), proc(300, 0, 'extension'), proc(400, 1, 'orphan')];
    expect(strayProcesses(entries, SELF)?.map(entry => entry.pid)).toEqual([7, 300, 400]);
  });
});

describe('parseProcStat', () => {
  it('reads pid, parent, state and name, even when the name holds spaces and parentheses', () => {
    expect(parseProcStat('1234 (Chrome (x) y) S 1 1234 1234 0 -1 4194560 120 0 0 0\n')).toEqual({
      pid: 1234,
      ppid: 1,
      state: 'S',
      name: 'Chrome (x) y',
      kernelThread: false,
    });
  });

  it('marks kernel threads by their PF_KTHREAD flag', () => {
    expect(parseProcStat('2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0')?.kernelThread).toBe(true);
  });

  it.each(['', 'garbage', '12 (name', 'x (name) S 1 1 1 0 -1 0'])('rejects the malformed line %j', line => {
    expect(parseProcStat(line)).toBeUndefined();
  });
});

describe('procfsProcessTable', () => {
  it.runIf(process.platform === 'linux')('lists this process with its parent from /proc', async () => {
    const entries = await procfsProcessTable.list();
    expect(entries).toContainEqual(expect.objectContaining({ pid: process.pid, ppid: process.ppid }));
  });
});
