import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('reads the version of the git the shell runs, which is on its PATH rather than this process PATH', async () => {
    const old = join(base, 'old');
    const fresh = join(base, 'fresh');
    for (const [folder, version] of [
      [old, '2.30.2'],
      [fresh, '2.38.0'],
    ] as const) {
      await mkdir(folder);
      await writeFile(join(folder, 'git'), `#!/bin/sh\necho "git version ${version}"\n`);
      await chmod(join(folder, 'git'), 0o755);
    }
    try {
      vi.stubEnv('PATH', fresh);
      vi.mocked(resolveUserPath).mockResolvedValue(old);
      expect(await withGrantedRoots([], () => gitRefusesImplicitBare(repo))).toBe(false);
      vi.stubEnv('PATH', old);
      vi.mocked(resolveUserPath).mockResolvedValue(fresh);
      expect(await withGrantedRoots([], () => gitRefusesImplicitBare(repo))).toBe(true);
      // A git inside a granted root is never started: the answer is that it does not refuse.
      expect(await withGrantedRoots([fresh], () => gitRefusesImplicitBare(repo))).toBe(false);
    } finally {
      vi.mocked(resolveUserPath).mockImplementation(async () => process.env.PATH ?? '');
    }
  });

  it.each([
    ['deprecated', ['own', 'deprecated', 'deprecated']],
    ['builtins,main', ['none', 'own', 'own']],
  ])('asks again after the %s listing exits 1, and keeps the answer once it succeeds', async (failing, expected) => {
    const fake = join(base, 'flaky');
    const marker = join(base, 'failed-once');
    await mkdir(fake);
    await writeFile(
      join(fake, 'git'),
      `#!/bin/sh\ncase "$*" in\n*--list-cmds=${failing}*) if [ ! -e "${marker}" ]; then : > "${marker}"; exit 1; fi;;\nesac\ncase "$*" in\n*--list-cmds=builtins,main*|*--list-cmds=${failing}*) echo zzz;;\nesac\n`
    );
    await chmod(join(fake, 'git'), 0o755);
    vi.stubEnv('PATH', fake);
    const kinds = [await kind([], 'zzz'), await kind([], 'zzz'), await kind([], 'zzz')];
    expect(kinds).toEqual(expected);
  });

  it('keeps the exit 128 answer for the deprecated listing, so a second lookup starts no second git', async () => {
    const fake = join(base, 'fake');
    const calls = join(base, 'calls.log');
    await mkdir(fake);
    await writeFile(
      join(fake, 'git'),
      `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in\n*--list-cmds=builtins,main*) echo sparse-checkout;;\n*--list-cmds=deprecated*) echo "unsupported command listing type" >&2; exit 128;;\nesac\n`
    );
    await chmod(join(fake, 'git'), 0o755);
    await writeFile(calls, '');
    vi.stubEnv('PATH', fake);
    expect(await kind([], 'sparse-checkout')).toBe('own');
    const first = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).length;
    expect(first).toBeGreaterThan(0);
    expect(await kind([], 'sparse-checkout')).toBe('own');
    expect((await readFile(calls, 'utf8')).split('\n').filter(Boolean).length).toBe(first);
  });
});
