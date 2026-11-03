import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_ROOT_PREFIX, removeDeadRunRoots } from '../../vitest.tempRoot';

describe('test temp root', () => {
  it('points every tmpdir and homedir variable at this file own directories', () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(/^b4m-desktop-test-/);
    expect(basename(dirname(root))).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}\\d+-`));
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

  it('removes the roots of dead runs and keeps live, unnamed and unrelated ones', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const dead = `${RUN_ROOT_PREFIX}${deadPid}-abc123`;
    const keep = [`${RUN_ROOT_PREFIX}${process.pid}-abc123`, `${RUN_ROOT_PREFIX}abc123`, 'unrelated-dir'];
    await Promise.all([dead, ...keep].map(name => mkdir(join(parent, name, 'nested'), { recursive: true })));

    await removeDeadRunRoots(parent);

    expect(existsSync(join(parent, dead))).toBe(false);
    expect(keep.map(name => existsSync(join(parent, name)))).toEqual([true, true, true]);
  });
});
