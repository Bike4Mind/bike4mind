import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const wrapper: { file: string } = vi.hoisted(() => ({ file: '' }));

// Stands in for wsl.exe: runs git through a script that records the WSLENV it was given.
vi.mock('../../git/hostGitArgs', async importOriginal => ({
  ...(await importOriginal<typeof import('../../git/hostGitArgs')>()),
  gitCommandEnv: vi.fn(async () => ({ PATH: process.env.PATH, WSLENV: 'USERPROFILE/p:HOME/w' })),
  gitCommand: vi.fn(async (_directory: string, args: readonly string[]) => ({ file: wrapper.file, args: [...args] })),
}));

import { gitOnBranchIncludes, gitSigningConfig, type GitSigningCall } from './shellWrites';

describe('the environment of a git query through wsl.exe', () => {
  let base = '';
  let repo = '';
  let recorded = '';

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-wslenv-')));
    repo = join(base, 'repo');
    recorded = join(base, 'wslenv');
    wrapper.file = join(base, 'git-wrapper');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(wrapper.file, `#!/bin/sh\nprintf '%s' "$WSLENV" > '${recorded}'\nexec git "$@"\n`);
    chmodSync(wrapper.file, 0o755);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const call = (env: Record<string, string>): GitSigningCall => ({
    gitDir: null,
    workTree: null,
    settings: [],
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });

  it('lists every variable the query sets in WSLENV, keeping the ones it already holds', async () => {
    expect(await gitSigningConfig(repo, call({ HOME: base, XDG_CONFIG_HOME: join(base, 'xdg') }))).toEqual([]);
    const names = readFileSync(recorded, 'utf8').split(':');
    for (const name of [
      'USERPROFILE/p',
      'GIT_ATTR_SOURCE',
      'GIT_NO_LAZY_FETCH',
      'GIT_ALLOW_PROTOCOL',
      'HOME',
      'XDG_CONFIG_HOME',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
    ]) {
      expect(names, name).toContain(name);
    }
    // A flag that keeps a listed name out of Linux is dropped for one the query sets.
    expect(names).not.toContain('HOME/w');
  });

  it('lists a variable set by the query of a fresh location too', async () => {
    expect(await gitOnBranchIncludes(repo, call({ GIT_CEILING_DIRECTORIES: base }))).toBe('none');
    expect(readFileSync(recorded, 'utf8').split(':')).toContain('GIT_CEILING_DIRECTORIES');
  });
});
