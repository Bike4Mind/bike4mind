import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_ROOT_ENV,
  RUN_ROOT_PREFIX,
  STALE_ROOT_AGE_MS,
  removeDeadRunRoots,
  removeRoot,
} from '../../vitest.tempRoot';

describe('test temp root', () => {
  it("points every tmpdir and homedir variable at this file's own directories", () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(/^b4m-desktop-test-/);
    expect(basename(dirname(root))).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}\\d+-`));
    expect(dirname(root)).toBe(process.env[RUN_ROOT_ENV]);
    expect([process.env.TMPDIR, process.env.TEMP, process.env.TMP]).toEqual([root, root, root]);

    const home = join(root, 'home');
    expect(homedir()).toBe(home);
    expect([process.env.HOME, process.env.USERPROFILE]).toEqual([home, home]);
  });

  it('hands the redirected directories to child processes', () => {
    const script = "const os = require('node:os'); console.log(os.tmpdir() + '\\n' + os.homedir())";
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(child.stdout.trim().split('\n')).toEqual([tmpdir(), homedir()]);
  });
});

describe('removeDeadRunRoots', () => {
  let parent: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'dead-run-roots-'));
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const age = (name: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    return utimes(join(parent, name), then, then);
  };

  it('removes the old roots of dead runs and keeps live, unnamed and unrelated ones', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const dead = `${RUN_ROOT_PREFIX}${deadPid}-abc123`;
    const keep = [`${RUN_ROOT_PREFIX}${process.pid}-abc123`, `${RUN_ROOT_PREFIX}abc123`, 'unrelated-dir'];
    await Promise.all([dead, ...keep].map(name => mkdir(join(parent, name, 'nested'), { recursive: true })));
    await Promise.all([dead, ...keep].map(name => age(name, STALE_ROOT_AGE_MS + 60_000)));

    await removeDeadRunRoots(parent);

    expect(existsSync(join(parent, dead))).toBe(false);
    expect(keep.map(name => existsSync(join(parent, name)))).toEqual([true, true, true]);
  });

  it('keeps the root of a dead pid until its mtime is old', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const fresh = `${RUN_ROOT_PREFIX}${deadPid}-fresh1`;
    const old = `${RUN_ROOT_PREFIX}${deadPid}-old123`;
    await Promise.all([fresh, old].map(name => mkdir(join(parent, name, 'nested'), { recursive: true })));
    await age(fresh, STALE_ROOT_AGE_MS - 60_000);
    await age(old, STALE_ROOT_AGE_MS + 60_000);

    await removeDeadRunRoots(parent);

    expect([fresh, old].map(name => existsSync(join(parent, name)))).toEqual([true, false]);
  });
});

describe('removeRoot', () => {
  it('removes a tree and resolves when removal fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remove-root-'));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'file'), '');

    await removeRoot(join(dir, 'file', 'child'));
    expect(existsSync(join(dir, 'file'))).toBe(true);

    await removeRoot(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
