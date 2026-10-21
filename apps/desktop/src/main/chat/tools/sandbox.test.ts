import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProfile, protectionFor, sandboxAvailable, sandboxCommand, secretPaths } from './sandbox';

describe('buildProfile', () => {
  it('denies writes everywhere before allowing them under each granted root', () => {
    const profile = buildProfile(['/Users/someone/code'], []);
    const denyAll = profile.indexOf('(deny file-write*)');
    const allowRoot = profile.indexOf('(allow file-write* (subpath "/Users/someone/code"))');

    expect(denyAll).toBeGreaterThan(-1);
    // Seatbelt is last-match-wins, so a blanket deny after the allow would revoke it.
    expect(allowRoot).toBeGreaterThan(denyAll);
  });

  /**
   * Regression guard for the case that makes ordering load-bearing: sharing the home folder
   * makes every credential store writable unless the denials come last.
   */
  it('keeps credential stores denied even when the folder above them is granted', () => {
    const profile = buildProfile([homedir()], []);
    const allowHome = profile.indexOf(`(allow file-write* (subpath "${homedir()}"))`);
    const denySsh = profile.indexOf(`(deny file-read* file-write* (subpath "${homedir()}/.ssh"))`);

    expect(denySsh).toBeGreaterThan(allowHome);
  });

  it('denies the paths the app protects regardless of what was granted', () => {
    const profile = buildProfile([homedir()], ['/Users/someone/Library/Application Support/b4m']);
    expect(profile).toContain(
      '(deny file-read* file-write* (subpath "/Users/someone/Library/Application Support/b4m"))'
    );
  });

  it('escapes quotes and backslashes so a path cannot end the profile string early', () => {
    const profile = buildProfile(['/tmp/od"d\\name'], []);
    expect(profile).toContain('(allow file-write* (subpath "/tmp/od\\"d\\\\name"))');
  });

  // On macOS tmpdir() is /var/folders/..., and seatbelt only ever sees /private/var/folders/...
  it('allows the temp folder under its resolved path, where seatbelt actually matches', () => {
    expect(buildProfile([], [])).toContain(`(allow file-write* (subpath "${realpathSync(tmpdir())}"))`);
  });

  it('grants and denies a symlinked folder under the path it resolves to', () => {
    const real = mkdtempSync(join(tmpdir(), 'b4m-sandbox-real-'));
    const link = join(mkdtempSync(join(tmpdir(), 'b4m-sandbox-link-')), 'project');
    symlinkSync(real, link);

    const profile = buildProfile([link], [link]);

    expect(profile).toContain(`(allow file-write* (subpath "${realpathSync(real)}"))`);
    expect(profile).toContain(`(deny file-read* file-write* (subpath "${realpathSync(real)}"))`);
  });
});

describe('the Claude Code folder', () => {
  // HOME is a temp folder of this run's own (vitest.setup.ts), never the real one.
  let home: string;
  let claude: string;

  beforeAll(() => {
    home = realpathSync(homedir());
    claude = join(home, '.claude');
    mkdirSync(join(claude, 'skills', 'x'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'x', 'SKILL.md'), 'the skill\n');
    writeFileSync(join(claude, 'settings.json'), '{}\n');
    writeFileSync(join(claude, '.credentials.json'), 'SECRET\n');
    writeFileSync(join(home, '.claude.json'), 'SECRET\n');
  });

  it('protects only the secrets and the grants, not the whole folder', () => {
    expect(secretPaths()).not.toContain(claude);
    expect(protectionFor([join(claude, 'skills', 'x', 'SKILL.md')], 'write')).toBeUndefined();
    expect(protectionFor([join(claude, 'CLAUDE.md')], 'write')).toBeUndefined();
    expect(protectionFor([join(claude, 'projects', 'p', 'log.jsonl')], 'read')).toBeUndefined();
    expect(protectionFor([join(claude, 'projects', 'p', 'log.jsonl')], 'write')).toMatch(/read-only/);
    expect(protectionFor([join(claude, '.credentials.json')], 'read')).toMatch(/credentials/);
    expect(protectionFor([join(home, '.claude.json.backup')], 'read')).toMatch(/credentials/);
    expect(protectionFor([join(claude, 'settings.local.json')], 'write')).toMatch(/only be changed by you/);
    expect(protectionFor(['/work/repo/.claude/settings.json'], 'write')).toMatch(/only be changed by you/);
    expect(protectionFor(['/work/repo/.claude/settings.json'], 'read')).toBeUndefined();
  });

  it('denies reads of secrets and writes of settings after every granted root', () => {
    const profile = buildProfile([home], []);
    const allowHome = profile.indexOf(`(allow file-write* (subpath "${home}"))`);

    expect(profile.indexOf(`(deny file-read* file-write* (subpath "${claude}/.credentials.json"))`)).toBeGreaterThan(
      allowHome
    );
    expect(profile.indexOf(`(deny file-read* file-write* (prefix "${home}/.claude.json"))`)).toBeGreaterThan(allowHome);
    expect(profile.indexOf('(deny file-write* (regex #"/\\.claude/settings[^/]*$"))')).toBeGreaterThan(allowHome);
    expect(profile).not.toContain(`(subpath "${claude}"))`);
  });

  describe.skipIf(!sandboxAvailable())('under sandbox-exec', () => {
    async function run(command: string, roots: string[]): Promise<{ ok: boolean; output: string }> {
      const sandboxed = await sandboxCommand(command, roots, []);
      try {
        const { stdout } = await promisify(execFile)(sandboxed.executable, sandboxed.args, { cwd: home });
        return { ok: true, output: stdout };
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      } finally {
        await sandboxed.cleanup();
      }
    }

    it('cannot read the credentials', async () => {
      const result = await run('cat .claude/.credentials.json', [home]);
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain('SECRET');
      expect((await run('cat .claude.json', [home])).output).not.toContain('SECRET');
    });

    it('reads and writes a skill', async () => {
      await expect(run('cat .claude/skills/x/SKILL.md', [home])).resolves.toEqual({ ok: true, output: 'the skill\n' });
      await expect(run('echo more >> .claude/skills/x/SKILL.md', [join(claude, 'skills')])).resolves.toMatchObject({
        ok: true,
      });
    });

    it('cannot write settings, directly or through a link', async () => {
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-sandbox-project-')));
      symlinkSync(join(claude, 'settings.json'), join(project, 'link.json'));

      for (const command of [
        'echo x >> .claude/settings.json',
        'echo x > .claude/settings.local.json',
        `echo x >> ${project}/link.json`,
        `mkdir -p ${project}/.claude && echo x > ${project}/.claude/settings.json`,
        `mkdir -p ${project}/n/o && ln -s o ${project}/n/.claude`,
        'mv .claude .claude-moved',
        `mkdir -p ${project}/nested/.claude && mv ${project}/nested/.claude ${project}/nested/moved`,
      ]) {
        expect((await run(command, [home, project])).ok, command).toBe(false);
      }
      expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe('{}\n');
    });
  });
});
