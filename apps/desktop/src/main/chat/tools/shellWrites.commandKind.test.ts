import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommandKind, withGrantedRoots } from './shellWrites';

describe('gitCommandKind answers kept across scans', () => {
  let base: string;
  let repo: string;
  let withProgram: string;
  let plain: string;

  const kind = (roots: readonly string[], name = 'zzz') => withGrantedRoots(roots, () => gitCommandKind(repo, name));

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-kind-')));
    repo = join(base, 'repo');
    withProgram = join(base, 'with');
    plain = join(base, 'plain');
    for (const folder of [repo, withProgram, plain]) await mkdir(folder);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    for (const folder of [withProgram, plain]) await symlink(realGit, join(folder, 'git'));
    await writeFile(join(withProgram, 'git-zzz'), '#!/bin/sh\nexit 0\n');
    await chmod(join(withProgram, 'git-zzz'), 0o755);
    execFileSync(realGit, ['-C', repo, 'init', '-q', '-b', 'main']);
    vi.stubEnv('HOME', join(base, 'home'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  it('reads a program git finds on PATH as its own, and a name with none as an alias', async () => {
    vi.stubEnv('PATH', withProgram);
    expect(await kind([])).toBe('own');
    expect(await kind([], 'zzy')).toBe('none');
    expect(await kind([], 'status')).toBe('own');
  });

  it('lists again for another PATH', async () => {
    vi.stubEnv('PATH', withProgram);
    expect(await kind([])).toBe('own');
    vi.stubEnv('PATH', plain);
    expect(await kind([])).toBe('none');
  });

  it('lists again for other roots, which pick the git and the programs it finds', async () => {
    vi.stubEnv('PATH', [withProgram, plain].join(delimiter));
    expect(await kind([])).toBe('own');
    expect(await kind([withProgram])).toBe('none');
  });
});
