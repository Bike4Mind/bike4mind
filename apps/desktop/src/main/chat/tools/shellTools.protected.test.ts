import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { resolveSubject } from '../permissions/resolveSubject';
import { permissionSubject } from '../permissions/subject';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

/** Each gets a `Bash(<program>:*)` allow rule, as a user who has allowed most everyday tools would have. */
const PROGRAMS = [
  'awk basename bash cat cd chmod chown command builtin cp curl cut date diff dirname dirs du echo env export file',
  'find git grep gzip head install jq ln ls make mkdir mktemp mv node npm npx patch pnpm popd printf pushd pwd',
  'python3 readlink realpath rg rm rmdir rsync sed sort stat tail tar tee test touch tr tree true false uniq unzip',
  'wc which xargs yarn zip tsc vitest eslint prettier go cargo docker ps kill sleep type source',
].flatMap(line => line.split(' '));

describe('shell commands that reach a protected location', () => {
  let base: string;
  let home: string;
  let userData: string;
  let claudeHome: string;
  let managed: string;
  let proj: string;
  let rules: PermissionRuleSet;
  let permissionRoots: readonly string[];

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-protected-')));
    home = join(base, 'home');
    userData = join(home, '.config', 'Bike4Mind');
    claudeHome = join(home, '.claude');
    managed = join(base, 'managed');
    proj = join(home, 'proj');
    for (const folder of [
      userData,
      claudeHome,
      managed,
      join(home, '.ssh'),
      join(proj, '.claude'),
      join(proj, 'src'),
      join(proj, 'build'),
      join(proj, 'dist'),
      join(proj, 'payload', '.claude'),
      join(proj, '.git'),
    ]) {
      await mkdir(folder, { recursive: true });
    }
    await writeFile(join(userData, 'vault.json'), '{}');
    await writeFile(join(claudeHome, 'settings.json'), '{}');
    await writeFile(join(managed, 'managed-settings.json'), '{}');
    await writeFile(join(home, '.ssh', 'id_rsa'), 'key');
    await writeFile(join(proj, '.claude', 'settings.json'), '{}');
    await writeFile(join(proj, 'payload', '.claude', 'settings.json'), '{}');
    await writeFile(join(proj, 'src', 'x'), 'x');
    await writeFile(join(proj, 'a'), 'a');
    await writeFile(join(proj, 'evil.json'), '{}');
    await writeFile(
      join(proj, 'evil.diff'),
      [
        'diff --git a/.claude/settings.local.json b/.claude/settings.local.json',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/.claude/settings.local.json',
        '@@ -0,0 +1 @@',
        '+{}',
        '',
      ].join('\n')
    );
    vi.stubEnv('HOME', home);
    permissionRoots = permissionProtectedLocations(userData, home, managed, { warn: () => {} }).paths();
    const compiled: CompiledRule[] = [];
    for (const program of PROGRAMS) {
      const parsed = parseRule(`Bash(${program}:*)`, { native: true });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, 'allow', { id: 'test', label: 'Test' }, { home, root: proj, cwd: proj });
      if (rule) compiled.push(rule);
    }
    rules = new PermissionRuleSet(compiled, () => permissionRoots);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  type Scenario = 'P' | 'H';

  /** How each mode treats `command`: whether auto and full run it unasked, and whether the rules allow it. */
  const judge = async (command: string, scenario: Scenario, cwd = proj) => {
    const context: ToolContext = {
      roots: scenario === 'P' ? [proj] : [home],
      workingDirectory: cwd,
      signal: new AbortController().signal,
      protectedPaths: [userData],
      uncoverablePaths: permissionRoots,
    };
    const prompt = await shellApproval('bash_execute', { command, cwd }, context);
    const subject = await resolveSubject(
      permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context)
    );
    return {
      auto: !prompt.askInAuto && (prompt.always?.directories ?? []).length === 0,
      full: !prompt.askInFull,
      allowed: rules.evaluate(subject).decision === 'allow',
    };
  };

  const refusedEverywhere = { auto: false, full: false, allowed: false };
  const scenarios: Scenario[] = ['P', 'H'];

  describe('a write the permission-protected set or the project settings guard', () => {
    it.each(scenarios)('asks before a GLOBIGNORE glob onto the project settings (%s)', async scenario => {
      expect(await judge('export GLOBIGNORE=x; cp evil.json */settings.local.json', scenario)).toEqual(
        refusedEverywhere
      );
    });

    it.each([
      "grep -r '' ~/.claude",
      'rg . ~/.claude',
      'ls -R ~/.claude',
      'cat ~/.claude/*',
      'du -a ~/.claude',
      'tree ~/.claude',
      "grep -r '' ~/.config",
    ])('asks in auto mode before %s, a read of a protected folder', async command => {
      const verdict = await judge(command, 'H');
      expect(verdict.auto).toBe(false);
      expect(verdict.allowed).toBe(false);
    });
  });

  describe('an operand the scan cannot read', () => {
    it.each([
      'D=.claude; cp evil.json $D/settings.local.json',
      'cp evil.json ${X:-.claude}/settings.local.json',
      'cp evil.json ${X:=.claude}/settings.local.json',
      'a=(.claude); cp evil.json ${a[0]}/settings.local.json',
      'cp evil.json "$(printf .cl%sude a)"/settings.local.json',
      'IFS=,; v=.cl,aude; cp -r payload/. $v',
    ])('asks in every mode before %s', async command => {
      expect(await judge(command, 'P')).toEqual(refusedEverywhere);
    });

    it('asks before a brace list too long to read', async () => {
      const words = Array.from({ length: 65 }, (_, index) => `w${index}`).join(',');
      expect(await judge(`cp evil.json ~/.config/{${words},Bike4Mind}/vault.json`, 'H')).toEqual(refusedEverywhere);
    });

    it('asks in auto mode only before a read whose operand it cannot read', async () => {
      expect(await judge('cat "$F"', 'P')).toMatchObject({ auto: false, full: true });
    });
  });

  describe('a copy into a target directory option', () => {
    it.each(['cp -rt.. ../payload/.', 'cp -r ../payload/. --target-directory=..', 'cp -r -t .. ../payload/.'])(
      'asks before %s writes the project settings',
      async command => {
        for (const scenario of scenarios) {
          expect(await judge(command, scenario, join(proj, 'src')), scenario).toEqual(refusedEverywhere);
        }
      }
    );

    it('asks before a glued target directory names the settings folder', async () => {
      expect(await judge('cp -t../.claude ../evil.json', 'P', join(proj, 'src'))).toEqual(refusedEverywhere);
      expect(await judge('mv -ft../.claude ../evil.json', 'P', join(proj, 'src'))).toEqual(refusedEverywhere);
    });
  });

  describe('xargs with a replace string', () => {
    it.each([
      'ls -A | xargs -I{} cp evil.json {}/settings.local.json',
      "find . -maxdepth 1 -name '.c*' -print0 | xargs -0 -I{} rm -rf {}",
      'ls -A | xargs -i cp evil.json {}/settings.local.json',
      'ls -A | xargs --replace=@ cp evil.json @/settings.local.json',
    ])('asks in every mode before %s', async command => {
      expect(await judge(command, 'P')).toEqual(refusedEverywhere);
    });
  });

  describe('a directory change the scan cannot follow', () => {
    // Each runs in the project, or in its `src` folder when the second entry says so.
    it.each([
      ['cd nope; cp evil.json ../.con*/Bike*/vault.json', ''],
      ['test -d nope && cd src; cp evil.json ../.con*/Bike*/vault.json', ''],
      ['pushd -n src; cp evil.json ../.con*/Bike*/vault.json', ''],
      ['pushd ..; popd -n; cp evil.json ../.con*/Bike*/vault.json', 'src'],
      ['pushd src; pushd +1; cp evil.json ../.con*/Bike*/vault.json', ''],
      ['command cd ..; cp evil.json ../.con*/Bike*/vault.json', 'src'],
      ['builtin cd ..; cp evil.json ../.con*/Bike*/vault.json', 'src'],
      ['export CDPATH=~; cd .config; cp evil.json Bike*/vault.json', ''],
      ['ls(){ cp evil.json .con*/Bike*/vault.json; }; cd ~; ls', ''],
      ['if true; then cd ~; fi; cp evil.json .con*/Bike*/vault.json', ''],
      ['cd src || cp evil.json ../.con*/Bike*/vault.json', ''],
      ['cd src && cd nope; cp evil.json ../../.con*/Bike*/vault.json', ''],
    ])('asks in every mode before %s', async (command, folder) => {
      expect(await judge(command, 'H', join(proj, folder))).toEqual(refusedEverywhere);
    });

    it.each([
      ['cd src/nope; cp -r payload/. ..', ''],
      ['cd nope; cp -r ../payload/. ..', 'src'],
    ])(
      'asks in every mode before %s, which writes a settings folder from where bash stays',
      async (command, folder) => {
        expect(await judge(command, 'P', join(proj, folder))).toEqual(refusedEverywhere);
      }
    );
  });

  it('asks before a backslash-newline joins a word the parser splits', async () => {
    expect(await judge('cp evil.json .cl\\\naude/settings.local.json', 'P')).toEqual(refusedEverywhere);
  });

  describe('a write only the in-place scan names', () => {
    it.each(['git apply evil.diff', 'patch -p1 -i evil.diff'])(
      'is allowed by no rule when %s targets the project settings',
      async command => {
        for (const scenario of scenarios) {
          expect(await judge(command, scenario), scenario).toEqual(refusedEverywhere);
        }
      }
    );
  });

  describe('a read of a secret in full mode', () => {
    it.each(['cat ~/.claude/settings.json', 'cat ~/.ssh/id_rsa', 'cat ~/.config/Bike4Mind/vault.json'])(
      'asks in full mode before %s',
      async command => {
        expect(await judge(command, 'H')).toMatchObject({ auto: false, full: false });
      }
    );
  });

  describe('git config setting a key that runs a program', () => {
    it.each([
      "git config core.fsmonitor 'touch pwned'; git status",
      "git config --local core.sshCommand 'touch pwned'",
      "git config set core.pager 'touch pwned'",
      "git config alias.st '!touch pwned'",
      "git config diff.json.textconv 'touch pwned'",
      "git config filter.x.clean 'touch pwned'",
      "git config --add credential.helper '!touch pwned'",
      'git config include.path ../evil',
    ])('asks in auto mode and no rule allows %s', async command => {
      const verdict = await judge(command, 'P');
      expect(verdict.auto).toBe(false);
      expect(verdict.allowed).toBe(false);
    });

    it.each(['git config user.name x', 'git config --get core.pager', 'git config get core.editor'])(
      'leaves %s to the mode',
      async command => {
        expect(await judge(command, 'P')).toEqual({ auto: true, full: true, allowed: true });
      }
    );
  });

  describe('everyday commands', () => {
    it.each([
      'rm -rf ./build/*',
      'rm -rf dist',
      'grep -r x src',
      'cat src/x',
      'ls *',
      'cp a b',
      'mkdir -p out && cd out && ls',
      'cd src && cat x',
      'cd src; cat x',
      'cd src && cat x && cd .. && cat a',
      'cd nope; cd ~/proj; cat a',
      'grep -r x .',
    ])('runs %s unasked', async command => {
      for (const scenario of scenarios) {
        expect(await judge(command, scenario), scenario).toEqual({ auto: true, full: true, allowed: true });
      }
    });
  });
});
