import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandEnv, launchCommand } from './commandLaunch';

vi.mock('./userPath', () => ({ resolveUserPath: async () => process.env.PATH ?? '' }));

const gitVersion = (): [number, number] => {
  const match = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  return [Number(match?.[1]), Number(match?.[2])];
};
const refusesImplicitBare = ((): boolean => {
  try {
    const [major, minor] = gitVersion();
    return major > 2 || (major === 2 && minor >= 38);
  } catch {
    return false;
  }
})();

describe.skipIf(process.platform === 'win32' || !refusesImplicitBare)(
  'the agent shell and a planted bare repository',
  () => {
    let base: string;

    beforeEach(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-bare-')));
      vi.stubEnv('HOME', join(base, 'home'));
      for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
      const bare = join(base, 'work', 'planted');
      await mkdir(bare, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', bare]);
      execFileSync('git', ['-C', bare, 'config', 'alias.st', `!touch ${join(base, 'MARK')}`]);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(base, { recursive: true, force: true });
    });

    const run = async (command: string, folder: string, withShellEnv: boolean) => {
      const launch = await launchCommand(command, [], [], folder);
      const env = withShellEnv ? await commandEnv(launch) : { ...process.env };
      return spawnSync(launch.executable, launch.args, { cwd: folder, env, encoding: 'utf8' });
    };

    it('refuses to run a `!` alias from a bare repository found by walking, which a plain git runs', async () => {
      const folder = join(base, 'work', 'planted');
      const control = await run('git st', folder, false);
      expect(control.status).toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(true);
      await rm(join(base, 'MARK'));

      const guarded = await run('git st', folder, true);
      expect(guarded.status).not.toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(false);
    });

    it('still lets a repository named outright run its alias, which the scan reads as git does', async () => {
      const folder = join(base, 'work');
      const guarded = await run('git --git-dir=planted st', folder, true);
      expect(guarded.status).toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(true);
    });

    it('keeps the setting when GIT_CONFIG_PARAMETERS allows implicit bare repositories', async () => {
      const folder = join(base, 'work', 'planted');
      vi.stubEnv('GIT_CONFIG_PARAMETERS', "'safe.bareRepository'='all'");
      const control = await run('git st', folder, false);
      expect(control.status).toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(true);
      await rm(join(base, 'MARK'));

      const guarded = await run('git st', folder, true);
      expect(guarded.status).not.toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(false);
    });

    it('keeps the setting when the environment already holds an unrelated count entry', async () => {
      const folder = join(base, 'work', 'planted');
      const guarded = await run('git st', folder, true);
      expect(guarded.status).not.toBe(0);
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'color.ui');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'always');
      const appended = await run('git st', folder, true);
      expect(appended.status).not.toBe(0);
      expect(existsSync(join(base, 'MARK'))).toBe(false);
    });
  }
);
