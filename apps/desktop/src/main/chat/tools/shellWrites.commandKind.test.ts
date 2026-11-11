import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommandKind, gitRefusesImplicitBare, withGrantedRoots } from './shellWrites';
import { resolveUserPath } from './userPath';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

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
    // A program in a granted root is not one the scan's git lists, but git itself runs it.
    expect(await kind([withProgram])).toBeNull();
  });

  it('reads a project folder on the shell PATH, not this process PATH, as one git runs programs from', async () => {
    await mkdir(join(repo, 'bin'));
    await writeFile(join(repo, 'bin', 'git-zzz'), '#!/bin/sh\nexit 0\n');
    await chmod(join(repo, 'bin', 'git-zzz'), 0o755);
    vi.stubEnv('PATH', plain);
    try {
      expect(await kind([])).toBe('none');
      vi.mocked(resolveUserPath).mockResolvedValue(`bin${delimiter}${plain}`);
      expect(await kind([])).toBeNull();
    } finally {
      vi.mocked(resolveUserPath).mockImplementation(async () => process.env.PATH ?? '');
    }
  });

  it('tells a git that honors safe.bareRepository from one that does not', async () => {
    const old = join(base, 'old');
    await mkdir(old);
    await writeFile(join(old, 'git'), '#!/bin/sh\necho "git version 2.30.2"\n');
    await chmod(join(old, 'git'), 0o755);
    const fresh = join(base, 'fresh');
    await mkdir(fresh);
    await writeFile(join(fresh, 'git'), '#!/bin/sh\necho "git version 2.38.0"\n');
    await chmod(join(fresh, 'git'), 0o755);
    const unknown = join(base, 'unknown');
    await mkdir(unknown);
    await writeFile(join(unknown, 'git'), '#!/bin/sh\necho nothing\n');
    await chmod(join(unknown, 'git'), 0o755);
    for (const [folder, expected] of [
      [unknown, false],
      [old, false],
      [fresh, true],
    ] as const) {
      vi.stubEnv('PATH', folder);
      expect(await withGrantedRoots([], () => gitRefusesImplicitBare(repo))).toBe(expected);
    }
  });
});
