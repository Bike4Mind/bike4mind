import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionProtectedLocations } from '../protectedLocations';
import { scanShell } from '../tools/shellScan';
import { permissionSubject } from './subject';
import {
  CLAUDE_CODE_TOOLS,
  type CompiledRule,
  type PermissionSubject,
  PermissionRuleSet,
  type RuleSource,
  compilePathGlob,
  compileRule,
  parseRule,
} from './rules';

const HOME = '/home/someone';
const PROJECT = '/work/project';
const SOURCE: RuleSource = { id: 'test', label: 'Test' };

function parsed(text: string, native = false) {
  const result = parseRule(text, { native });
  if (!result.ok) throw new Error(`${text}: ${result.reason}`);
  return result.rule;
}

function set(lists: { allow?: string[]; ask?: string[]; deny?: string[] }, protectedRoots: string[] = []) {
  const rules: CompiledRule[] = [];
  for (const list of ['allow', 'ask', 'deny'] as const) {
    for (const text of lists[list] ?? []) {
      const compiled = compileRule(parsed(text, true), list, SOURCE, { home: HOME, root: PROJECT, cwd: PROJECT });
      if (compiled) rules.push(compiled);
    }
  }
  return new PermissionRuleSet(rules, protectedRoots);
}

type Command = { text: string; words?: string; coverable?: boolean; opaque?: string };

function shell(script: string, commands: (string | Command)[], directories: string[] = []): PermissionSubject {
  return {
    tool: 'bash_execute',
    shell: {
      script,
      commands: commands.map(command =>
        typeof command === 'string'
          ? { text: command, words: command, coverable: true }
          : { coverable: true, ...command }
      ),
      directories,
    },
  };
}

const decide = (rules: PermissionRuleSet, subject: PermissionSubject) => rules.evaluate(subject).decision;

describe('parseRule', () => {
  it('maps every Claude Code tool name through the one table', () => {
    expect(parsed('Bash').tools).toEqual(['bash_execute', 'bash_background']);
    expect(parsed('Read').tools).toEqual(['file_read', 'glob_files', 'grep_search']);
    expect(parsed('Edit').tools).toEqual(['file_edit', 'file_write', 'apply_patch']);
    expect(parsed('Write').tools).toEqual(['file_write']);
    expect(parsed('WebFetch').tools).toEqual(['web_fetch']);
    expect(parsed('WebSearch').tools).toEqual(['web_search']);
    for (const [name, mapping] of Object.entries(CLAUDE_CODE_TOOLS)) expect(parsed(name).tools).toEqual(mapping.tools);
  });

  it('reads both prefix forms and the exact form of a Bash rule', () => {
    const colon = parsed('Bash(git status:*)').matcher;
    const space = parsed('Bash(git status *)').matcher;
    const exact = parsed('Bash(npm test)').matcher;
    expect(colon).toMatchObject({ kind: 'shell', exact: false, literal: 'git status' });
    expect(space).toMatchObject({ kind: 'shell', exact: false, literal: 'git status' });
    expect(exact).toMatchObject({ kind: 'shell', exact: true, literal: 'npm test' });
    expect(parsed('Bash(*)').matcher).toEqual({ kind: 'any' });
  });

  it('reads path, domain and MCP rules', () => {
    expect(parsed('Read(//abs/**)').matcher).toEqual({ kind: 'path', spec: '//abs/**' });
    expect(parsed('Edit(~/notes/*.md)').matcher).toEqual({ kind: 'path', spec: '~/notes/*.md' });
    expect(parsed('WebFetch(domain:docs.example.com)').matcher).toEqual({
      kind: 'domain',
      host: 'docs.example.com',
      wildcard: false,
    });
    expect(parsed('WebFetch(domain:*.example.com)').matcher).toEqual({
      kind: 'domain',
      host: 'example.com',
      wildcard: true,
    });
    expect(parsed('mcp__My Server__search'.replace(' ', '-')).matcher).toEqual({
      kind: 'mcp',
      server: 'my-server',
      tool: 'search',
    });
    expect(parsed('mcp__github').matcher).toEqual({ kind: 'mcp', server: 'github', tool: null });
    expect(parsed('mcp__github__*').matcher).toEqual({ kind: 'mcp', server: 'github', tool: null });
  });

  it('refuses what does not parse or map, with a reason', () => {
    for (const bad of [
      'Task',
      'TodoWrite',
      'NotebookEdit(x)',
      'Bash()',
      'Bash(:*)',
      'WebFetch(example.com)',
      'WebSearch(x)',
      'not a rule!',
      'mcp__x(y)',
      'constructor',
      'toString(x)',
      '__proto__',
      'valueOf',
      'hasOwnProperty(x)',
    ]) {
      const result = parseRule(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe('');
    }
  });

  it('admits desktop tool names only in the desktop rules', () => {
    expect(parseRule('session_spawn').ok).toBe(false);
    expect(parsed('session_spawn', true)).toMatchObject({ tools: ['session_spawn'], matcher: { kind: 'any' } });
    expect(parsed('bash_execute(git log:*)', true).matcher).toMatchObject({ kind: 'shell', literal: 'git log' });
    expect(parseRule('file_read(x)', { native: true }).ok).toBe(false);
  });
});

describe('compilePathGlob', () => {
  const base = { home: HOME, root: PROJECT, cwd: `${PROJECT}/sub` };
  const matches = (spec: string, path: string) => compilePathGlob(spec, base)?.test(path) ?? false;

  it('resolves //, ~/, a leading / and a relative path', () => {
    expect(matches('//etc/hosts', '/etc/hosts')).toBe(true);
    expect(matches('~/notes/**', `${HOME}/notes/a/b.md`)).toBe(true);
    expect(matches('/src/**', `${PROJECT}/src/x.ts`)).toBe(true);
    expect(matches('/src/**', `${PROJECT}/sub/src/x.ts`)).toBe(false);
    expect(matches('./docs/*.md', `${PROJECT}/sub/docs/a.md`)).toBe(true);
  });

  it('follows gitignore: * stays in one folder, ** crosses folders, a bare name matches at any depth', () => {
    expect(matches('~/notes/*.md', `${HOME}/notes/a.md`)).toBe(true);
    expect(matches('~/notes/*.md', `${HOME}/notes/deep/a.md`)).toBe(false);
    expect(matches('~/notes/**/*.md', `${HOME}/notes/deep/a.md`)).toBe(true);
    expect(matches('.env', `${PROJECT}/sub/deep/.env`)).toBe(true);
    expect(matches('~/secret', `${HOME}/secret/inside.txt`)).toBe(true);
  });

  it('is null for a rule that needs a base the context lacks', () => {
    expect(compilePathGlob('src/**', { home: HOME, root: null, cwd: null })).toBeNull();
    expect(compilePathGlob('/src/**', { home: HOME, root: null, cwd: PROJECT })).toBeNull();
  });
});

describe('PermissionRuleSet', () => {
  // The shapes of a real user's Claude Code allow list, with no real paths.
  const shared = set({
    allow: [
      'Bash(ls:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(grep:*)',
      "Bash(node -e ' *)",
      `Read(/${HOME}/**)`,
    ],
  });

  it('matches a prefix on a word boundary', () => {
    expect(decide(shared, shell('ls -la', ['ls -la']))).toBe('allow');
    expect(decide(shared, shell('ls', ['ls']))).toBe('allow');
    expect(decide(shared, shell('lsof -i', ['lsof -i']))).toBeNull();
    expect(decide(shared, shell('git status --short', ['git status --short']))).toBe('allow');
    expect(decide(shared, shell('git push', ['git push']))).toBeNull();
  });

  it('allows a compound command only when every sub-command is allowed', () => {
    expect(decide(shared, shell('git status && git diff | grep x', ['git status', 'git diff', 'grep x']))).toBe(
      'allow'
    );
    expect(decide(shared, shell('git status && rm -rf x', ['git status', 'rm -rf x']))).toBeNull();
  });

  it('refuses the whole command when any sub-command is denied, and deny beats ask beats allow', () => {
    const rules = set({ allow: ['Bash(git:*)', 'Bash(rm:*)'], ask: ['Bash(git push:*)'], deny: ['Bash(rm -rf:*)'] });
    expect(decide(rules, shell('git status && rm -rf x', ['git status', 'rm -rf x']))).toBe('deny');
    expect(decide(rules, shell('git add . && git push', ['git add .', 'git push']))).toBe('ask');
    expect(decide(rules, shell('git add .', ['git add .']))).toBe('allow');
    expect(decide(rules, shell('rm x', ['rm x']))).toBe('allow');
  });

  it('matches a rule against the command as written or as normalised', () => {
    const rules = set({ allow: ['Bash(git commit:*)'] });
    expect(
      decide(rules, shell('git -C sub commit -m x', [{ text: 'git commit -m x', words: 'git -C sub commit -m x' }]))
    ).toBe('allow');
  });

  it('covers an opaque command only with a rule naming its form', () => {
    const inline = { text: "node -e 'x()'", words: "node -e 'x()'", opaque: 'node -e' };
    expect(decide(shared, shell("node -e 'x()'", [inline]))).toBe('allow');
    const broad = set({ allow: ['Bash(node:*)', 'Bash(bash:*)', 'Bash', 'Bash(eval:*)'] });
    expect(decide(broad, shell("node -e 'x()'", [inline]))).toBeNull();
    expect(decide(broad, shell('bash -c "$X"', [{ text: 'bash -c "$X"', opaque: 'bash -c' }]))).toBeNull();
    expect(decide(broad, shell('eval "$X"', [{ text: 'eval "$X"', opaque: 'eval' }]))).toBe('allow');
    expect(
      decide(set({ allow: ['Bash(bash -c:*)'] }), shell('bash -c "$X"', [{ text: 'bash -c "$X"', opaque: 'bash -c' }]))
    ).toBe('allow');
  });

  it('covers a command it could not normalise only with an exact rule', () => {
    const assigned = { text: 'GIT_DIR=x git status', words: 'GIT_DIR=x git status', coverable: false };
    expect(decide(shared, shell('GIT_DIR=x git status', [assigned]))).toBeNull();
    expect(decide(set({ allow: ['Bash(GIT_DIR=x git status)'] }), shell('GIT_DIR=x git status', [assigned]))).toBe(
      'allow'
    );
  });

  it('matches a toolchain run past a tuning variable both with and without naming it', async () => {
    const script = 'NODE_ENV=production pnpm build';
    const scan = await scanShell(script, PROJECT, [PROJECT]);
    if (!scan) throw new Error('Expected the script to parse');
    const subject = shell(script, scan.commands);
    expect(decide(set({ allow: ['Bash(pnpm build:*)'] }), subject)).toBe('allow');
    expect(decide(set({ allow: ['Bash(NODE_ENV=production pnpm build:*)'] }), subject)).toBe('allow');
    expect(decide(set({ deny: ['Bash(NODE_ENV=production pnpm build:*)'] }), subject)).toBe('deny');
    expect(decide(set({ ask: ['Bash(NODE_ENV=production pnpm build)'] }), subject)).toBe('ask');
  });

  it('requires an explicit eval form for Deno inline code', async () => {
    const script = 'deno eval "fetch(1)"';
    const scan = await scanShell(script, PROJECT, [PROJECT]);
    if (!scan) throw new Error('Expected the inline command to parse');
    expect(decide(set({ allow: ['Bash(deno:*)'] }), shell(script, scan.commands))).toBeNull();
    expect(decide(set({ allow: ['Bash(deno eval:*)'] }), shell(script, scan.commands))).toBe('allow');
  });

  it.each([
    'GIT_CONFIG_PARAMETERS=evil git status',
    'GIT_EXTERNAL_DIFF=./payload git status',
    'git status > out.txt',
    'git status 2> errors.txt',
    '> out.txt git status',
    "git status <<'EOF' > out.txt\ninput\nEOF",
  ])('an exact rule does not discard the unsafe syntax in %s', async script => {
    const scan = await scanShell(script, PROJECT, [PROJECT]);
    if (!scan) throw new Error('Expected the regression script to parse');
    const subject = shell(script, scan.commands, scan.directories);
    expect(decide(set({ allow: ['Bash(git status)'] }), subject)).toBeNull();
    expect(decide(set({ allow: [`Bash(${script})`] }), subject)).toBe('allow');
  });

  it('asks for a folder outside the shared ones unless a Read or Edit rule covers it', () => {
    const outside = shell('ls /srv/data', ['ls /srv/data'], ['/srv/data']);
    expect(decide(set({ allow: ['Bash(ls:*)'] }), outside)).toBeNull();
    expect(decide(set({ allow: ['Bash(ls:*)', 'Read(//srv/**)'] }), outside)).toBe('allow');
    expect(decide(set({ allow: ['Bash(ls:*)', 'Edit(//srv/data)'] }), outside)).toBe('allow');
  });

  it('leaves a call that reaches a distro no folder is in to ask, whatever allow rule names the command', () => {
    const reach = ['\\\\wsl.localhost\\Debian\\root\\.ssh\\id_rsa'];
    const base = shell('cat x', ['cat x']);
    const subject: PermissionSubject = { ...base, shell: { ...base.shell!, ungranted: reach } };
    expect(decide(set({ allow: ['Bash(cat:*)'] }), base)).toBe('allow');
    expect(decide(set({ allow: ['Bash(cat:*)'] }), subject)).toBeNull();
    expect(decide(set({ allow: ['Bash'] }), subject)).toBeNull();
    expect(decide(set({ allow: ['Bash(cat x)'] }), subject)).toBeNull();
    expect(decide(set({ allow: ['Bash(cat:*)'], ask: ['Bash(cat:*)'] }), subject)).toBe('ask');
  });

  it('never lets an allow rule reach a permission file', () => {
    const rules = set({ allow: ['Bash(cp:*)', `Read(/${HOME}/**)`, `Edit(/${HOME}/**)`] }, [`${HOME}/.claude`]);
    expect(decide(rules, shell('cp x .claude/settings.local.json', ['cp x .claude/settings.local.json']))).toBeNull();
    expect(decide(rules, shell('cp x y', ['cp x y'], [`${HOME}/.claude`]))).toBeNull();
    expect(decide(rules, shell('cp x y', ['cp x y'], [HOME]))).toBeNull();
    expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/.claude/settings.json`] })).toBeNull();
    expect(decide(rules, { tool: 'file_write', paths: [`${PROJECT}/.claude/settings.json`] })).toBeNull();
    expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/notes.md`] })).toBe('allow');
  });

  it.each(['settings.json', 'settings.local.json', 'permission-rules.json'])(
    'does not allow a shell write through a symlink to %s inside a shared root',
    async filename => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'permission-paths-')));
      try {
        const protectedDirectory = join(directory, filename === 'permission-rules.json' ? 'app-data' : '.claude');
        await mkdir(protectedDirectory);
        await writeFile(join(protectedDirectory, filename), '{}');
        await writeFile(join(directory, 'payload'), '{}');
        await symlink(protectedDirectory, join(directory, 'alias'));
        const script = `cp payload alias/${filename}`;
        const scan = await scanShell(script, directory, [directory]);
        if (!scan) throw new Error('Expected the alias command to parse');
        expect(scan.directories).toEqual([]);
        expect(scan.paths).toContain(join(protectedDirectory, filename));
        const subject = permissionSubject(
          { name: 'bash_execute', input: { command: script } },
          {
            detail: '',
            key: 'test',
            always: {
              namespace: 'bash_execute',
              commands: scan.commands.map(command => ({ ...command, pattern: command.always })),
              directories: scan.directories,
              paths: scan.paths,
            },
          },
          { roots: [directory], workingDirectory: directory }
        );
        expect(decide(set({ allow: ['Bash(cp:*)'] }, [protectedDirectory]), subject)).toBeNull();
        // Copying a file into the aliased folder names only that folder, not its final target.
        const intoFolder = await scanShell(`cp ${filename} alias/`, directory, [directory]);
        if (!intoFolder) throw new Error('Expected the destination-folder command to parse');
        expect(
          decide(set({ allow: ['Bash(cp:*)'] }), {
            tool: 'bash_execute',
            shell: { script: `cp ${filename} alias/`, ...intoFolder },
          })
        ).toBeNull();
        // Starting inside the protected folder must be caught even when no argument names it.
        const inside = await scanShell('cp payload other.json', protectedDirectory, [directory]);
        if (!inside) throw new Error('Expected the protected cwd command to parse');
        expect(
          decide(set({ allow: ['Bash(cp:*)'] }, [protectedDirectory]), {
            tool: 'bash_execute',
            shell: { script: 'cp payload other.json', ...inside },
          })
        ).toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('does not allow a shell write into an app folder whose configured spelling runs through a symlink', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'permission-roots-')));
    try {
      await mkdir(join(base, 'config', 'App'), { recursive: true });
      await mkdir(join(base, 'proj'));
      await mkdir(join(base, 'home'));
      await writeFile(join(base, 'proj', 'payload'), '{}');
      await symlink(join(base, 'config'), join(base, 'cfg-link'));
      const script = `cp payload ${join(base, 'config', 'App', 'tool-access.json')}`;
      const scan = await scanShell(script, join(base, 'proj'), [base]);
      if (!scan) throw new Error('Expected the command to parse');
      const subject: PermissionSubject = { tool: 'bash_execute', shell: { script, ...scan } };
      const roots = [
        ...permissionProtectedLocations(join(base, 'cfg-link', 'App'), join(base, 'home'), join(base, 'managed'), {
          warn: () => {},
        }).paths(),
      ];
      expect(decide(set({ allow: ['Bash(cp:*)'] }, roots), subject)).toBeNull();
      expect(decide(set({ allow: ['Bash(cp:*)'] }, [join(base, 'cfg-link', 'App')]), subject)).toBe('allow');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not allow an edit that reaches a protected folder through a symlinked parent', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'permission-roots-')));
    try {
      await mkdir(join(base, 'config', 'App'), { recursive: true });
      await symlink(join(base, 'config'), join(base, 'cfg-link'));
      const rules = set({ allow: [`Edit(/${base}/**)`] }, [join(base, 'config', 'App')]);
      const linked = join(base, 'cfg-link', 'App');
      expect(decide(rules, { tool: 'file_write', paths: [join(linked, 'tool-access.json')] })).toBeNull();
      expect(decide(rules, { tool: 'file_write', paths: [join(linked, 'new', 'file.json')] })).toBeNull();
      expect(rules.coversFolder(linked)).toBe(false);
      expect(decide(rules, { tool: 'file_write', paths: [join(base, 'cfg-link', 'Other.json')] })).toBe('allow');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not allow an edit of a dangling link inside a protected folder reached through an alias', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'permission-roots-')));
    try {
      await mkdir(join(base, 'home', 'prot'), { recursive: true });
      await mkdir(join(base, 'out'));
      await symlink(join(base, 'home'), join(base, 'alias'));
      await symlink(join(base, 'out', 'x'), join(base, 'home', 'prot', 'lnk'));
      const rules = set({ allow: ['Edit'] }, [join(base, 'home', 'prot')]);
      expect(decide(rules, { tool: 'file_edit', paths: [join(base, 'alias', 'prot', 'lnk')] })).toBeNull();
      expect(decide(rules, { tool: 'file_edit', paths: [join(base, 'alias', 'other')] })).toBe('allow');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not allow an edit of a path whose parent cannot be resolved, though the path itself can', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'permission-roots-')));
    const native = realpathSync.native;
    vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
      if (String(path) === join(base, 'dir')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return native(path, options);
    });
    try {
      await mkdir(join(base, 'dir'));
      await writeFile(join(base, 'dir', 'file'), 'x');
      const rules = set({ allow: ['Edit'] }, [join(base, 'prot')]);
      expect(decide(rules, { tool: 'file_edit', paths: [join(base, 'dir', 'file')] })).toBeNull();
      expect(decide(rules, { tool: 'file_edit', paths: [join(base, 'other')] })).toBe('allow');
    } finally {
      vi.restoreAllMocks();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reads the protected roots from their provider on each decision', () => {
    let roots: readonly string[] = [];
    const compiled = compileRule(parsed('Edit', true), 'allow', SOURCE, { home: HOME, root: PROJECT, cwd: PROJECT });
    if (!compiled) throw new Error('Expected the rule to compile');
    const rules = new PermissionRuleSet([compiled], () => roots);
    const subject: PermissionSubject = { tool: 'file_edit', paths: [join(PROJECT, 'prot', 'file')] };
    expect(decide(rules, subject)).toBe('allow');
    roots = [join(PROJECT, 'prot')];
    expect(decide(rules, subject)).toBeNull();
    expect(rules.coversFolder(join(PROJECT, 'prot'))).toBe(false);
  });

  it('applies no allow rule while a protected folder is unresolved', () => {
    let unresolved: readonly string[] = ['/home/someone/.claude'];
    const rules = ['Edit(**)', 'Bash(git status:*)'].map(text => {
      const compiled = compileRule(parsed(text, true), 'allow', SOURCE, { home: HOME, root: PROJECT, cwd: PROJECT });
      if (!compiled) throw new Error('Expected the rule to compile');
      return compiled;
    });
    const set = new PermissionRuleSet(rules, [], () => unresolved);
    const edit: PermissionSubject = { tool: 'file_edit', paths: [join(PROJECT, 'file')] };
    const bash = shell('git status', ['git status'], [PROJECT]);
    expect(decide(set, edit)).toBeNull();
    expect(decide(set, bash)).toBeNull();
    unresolved = [];
    expect(decide(set, edit)).toBe('allow');
    expect(decide(set, bash)).toBe('allow');
  });

  describe('a shell command beside a protected folder inside the shared one', () => {
    let base: string;
    let directory: string;
    const allow = [
      'Bash(rm:*)',
      'Bash(mv:*)',
      'Bash(ln:*)',
      'Bash(unlink:*)',
      'Bash(cat:*)',
      'Bash(ls:*)',
      'Bash(echo:*)',
      'Bash(git commit:*)',
    ];

    beforeEach(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'permission-shell-')));
      directory = join(base, 'dir');
      await mkdir(join(directory, 'app-data'), { recursive: true });
      await mkdir(join(directory, 'src'));
      await writeFile(join(directory, 'payload'), '{}');
      await writeFile(join(directory, 'app-data', 'file'), '{}');
      await symlink(join(directory, 'payload'), join(directory, 'app-data', 'lnk'));
    });

    afterEach(async () => {
      await rm(base, { recursive: true, force: true });
    });

    const decideScript = async (script: string, cwd = directory): Promise<string | null> => {
      const scan = await scanShell(script, cwd, [directory]);
      if (!scan) throw new Error(`Expected ${script} to parse`);
      return decide(set({ allow }, [join(directory, 'app-data')]), {
        tool: 'bash_execute',
        shell: { script, ...scan },
      });
    };

    it.each(['rm app-data/file', 'rm app-data/sub/../file'])('asks for %s', async script => {
      expect(await decideScript(script)).toBeNull();
    });

    it.each(['rm app-data/lnk', 'mv app-data/lnk moved', 'ln -sf payload app-data/lnk', 'unlink app-data/lnk'])(
      'asks for %s, which acts on the link inside the protected folder',
      async script => {
        expect(await decideScript(script)).toBeNull();
      }
    );

    it.each(['rm app-d?ta/file', 'rm app-*/file', 'rm */file', 'rm -r app-d*', 'cat app-d?ta/file'])(
      'asks for %s, whose glob may reach the protected folder',
      async script => {
        expect(await decideScript(script)).toBeNull();
      }
    );

    it.each([
      'rm "$PWD/app-data/file"',
      'rm `pwd`/app-data/file',
      'X=app-data; rm $X/file',
      'cd "$PWD/app-data" && rm file',
      'cat < "$PWD/app-data/file"',
    ])('asks for %s, whose operand a variable or substitution decides', async script => {
      expect(await decideScript(script)).toBeNull();
    });

    it.each(['rm payload', 'rm src/x.ts', 'ls src/*.ts', 'cat "app-d?ta/file"', "cat '$x'", 'mv payload src/moved'])(
      'still allows %s',
      async script => {
        expect(await decideScript(script)).toBe('allow');
      }
    );

    it.each([
      'rm "$PWD/../app-data/file"',
      'rm $(echo ..)/app-data/file',
      'cd "$PWD/../app-data" && rm file',
      'cat < "$PWD/../app-data/file"',
    ])('asks for %s from a folder that holds no protected one', async script => {
      expect(await decideScript(script, join(directory, 'src'))).toBeNull();
    });

    describe('from a project whose .claude folder holds its settings', () => {
      // As in production: the project's .claude is guarded by name, not listed as a protected root.
      const fromProject = async (script: string): Promise<string | null> => {
        const project = join(directory, 'project');
        await mkdir(join(project, '.claude'), { recursive: true });
        await mkdir(join(project, 'src'));
        const scan = await scanShell(script, project, [directory]);
        if (!scan) throw new Error(`Expected ${script} to parse`);
        const roots = permissionProtectedLocations(
          join(directory, 'app-data'),
          join(base, 'home'),
          join(base, 'managed'),
          {
            warn: () => {},
          }
        ).paths();
        return decide(set({ allow: [...allow, 'Bash(grep:*)'] }, [...roots]), {
          tool: 'bash_execute',
          shell: { script, ...scan },
        });
      };

      it.each(['echo "$X"', 'git commit -m "$(cat msg)"', 'grep "$PAT" src', 'ls *'])(
        'still allows %s by its prefix rule',
        async script => {
          expect(await fromProject(script)).toBe('allow');
        }
      );

      it.each(['rm "$X"', 'cat < "$X"', 'ls .c*'])('asks for %s', async script => {
        expect(await fromProject(script)).toBeNull();
      });
    });

    it.each(['git commit -m "$(cat msg)"', 'echo "$X"', 'echo hi'])(
      'still allows %s, whose expanded argument names no path, by its prefix rule',
      async script => {
        expect(await decideScript(script, join(directory, 'src'))).toBe('allow');
      }
    );
  });

  describe('a shell command under prefix rules, with production-shaped protected locations', () => {
    let base: string;
    let home: string;
    let directory: string;
    const allow = [
      'rm',
      'cp',
      'mv',
      'ln',
      'tee',
      'cat',
      'ls',
      'echo',
      'mkdir',
      'touch',
      'chmod',
      'chown',
      'find',
      'grep',
      'rg',
      'sed',
      'awk',
      'dd',
      'tar',
      'rsync',
      'git',
      'head',
      'tail',
      'wc',
      'sort',
      'diff',
      'unlink',
      'install',
      'du',
      'tree',
    ].map(program => `Bash(${program}:*)`);

    beforeEach(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'permission-review-')));
      home = join(base, 'home');
      directory = join(base, 'dir');
      await mkdir(join(home, '.claude'), { recursive: true });
      await mkdir(join(home, '.config', 'App'), { recursive: true });
      await mkdir(join(home, 'proj', 'src'), { recursive: true });
      await mkdir(join(directory, 'app-data'), { recursive: true });
      await mkdir(join(directory, 'outside'), { recursive: true });
      await mkdir(join(directory, 'src'), { recursive: true });
      await mkdir(join(directory, 'stage'), { recursive: true });
      await mkdir(join(directory, 'project', '.claude'), { recursive: true });
      await mkdir(join(directory, 'project', 'src'), { recursive: true });
      await writeFile(join(directory, 'payload'), '{}');
      await writeFile(join(directory, 'app-data', 'file'), '{}');
      await writeFile(join(directory, 'outside', 'vault'), '{}');
      await writeFile(join(directory, 'project', '.claude', 'settings.local.json'), '{}');
      vi.stubEnv('HOME', home);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(base, { recursive: true, force: true });
    });

    /** The decision for `script` run in `cwd` with `userData` as the app's folder; the project's .claude is no root. */
    const decideIn = async (
      script: string,
      cwd: string,
      userData: string,
      shared: readonly string[] = [directory]
    ): Promise<string | null> => {
      const scan = await scanShell(script, cwd, shared);
      if (!scan) throw new Error(`Expected ${script} to parse`);
      const roots = permissionProtectedLocations(userData, home, join(base, 'managed'), { warn: () => {} }).paths();
      return decide(set({ allow }, [...roots]), { tool: 'bash_execute', shell: { script, ...scan } });
    };
    const fromShared = (script: string) => decideIn(script, directory, join(directory, 'app-data'));
    const fromProject = (script: string) => decideIn(script, join(directory, 'project'), join(directory, 'app-data'));
    const fromHome = (script: string) => decideIn(script, join(home, 'proj'), join(home, '.config', 'App'), [home]);

    it.each([
      'cp ../payload .c*/settings.local.json',
      'tee .c*/settings.local.json < x',
      'mv x .clau?e/settings.local.json',
      'cp x .[c]laude/settings.local.json',
      'rm .c*/settings.local.json',
      'ln -s .c* l && cp x l/settings.local.json',
      'rm -rf .',
      'chmod -R 777 .',
      'rsync -a ../stage/ ./',
      'find . -name settings.local.json -delete',
    ])('asks for %s, which reaches the project settings', async script => {
      expect(await fromProject(script)).toBeNull();
    });

    it.each([
      'rsync -a stage/ "$HOME"/',
      'tar -C "$HOME"/.config/App -xf evil.tar',
      'dd if=x of="$HOME"/.config/App/f',
      'sed -i s/a/b/ "$HOME"/.config/App/f',
      'grep -r x "$HOME"/.config/App',
      'tar -C "$X" -xf x',
    ])('asks for %s, whose expanded operand is a path', async script => {
      expect(await fromHome(script)).toBeNull();
    });

    it.each(['sed -n p "$PWD"/../outside/vault', 'awk 1 ${PWD%/*}/outside/vault'])(
      'asks for %s, which reads a protected folder through the working folder',
      async script => {
        expect(await decideIn(script, join(directory, 'src'), join(directory, 'outside'))).toBeNull();
      }
    );

    it.each([
      "cp x '.cl'aude/settings.local.json",
      'cp x .cl""aude/settings.local.json',
      'cp x .cl{a..a}ude/settings.local.json',
      'echo x | tee .cl{a,}ude/settings.local.json',
      "rm 'app'-data/file",
      'rm app\\-data/file',
      "git -C 'app'-data clean -fdx",
      "rsync src/ 'app'-data/",
      "dd of='app'-data/f",
      "cat < 'app'-data/file",
      'mkdir app-d{a,}ta/x',
    ])('asks for %s, whose quoted, escaped or braced operand names a protected path', async script => {
      expect(await fromShared(script)).toBeNull();
    });

    it.each(['ln -s app-data ../l6 && cp ../payload ../l6/file', 'ln -s app-data ../l6 && rm -rf ../l6/'])(
      'asks for %s, which writes through a link it made',
      async script => {
        expect(await decideIn(script, join(directory, 'src'), join(directory, 'app-data'))).toBeNull();
      }
    );

    it.each(['sed -i s/a/b/ ~+/app-data/file', 'cd src && sed -i s/a/b/ ~-/app-data/file'])(
      'asks for %s, whose ~+ or ~- names a working folder',
      async script => {
        expect(await fromShared(script)).toBeNull();
      }
    );

    it.each([
      'find . -delete',
      'find . -name file -delete',
      'chmod -R 777 .',
      'mv .. /tmp/x',
      'grep -r x .',
      'cd src && chmod -R 777 ..',
    ])('asks for %s, which acts on a tree holding a protected folder', async script => {
      expect(await fromShared(script)).toBeNull();
    });

    it.each([
      `awk '{print > "out"}' x`,
      `awk '{print | "sh"}' x`,
      `awk 'BEGIN {system("id")}'`,
      "sed -n 'w out' x",
      "sed 's/a/b/w out' x",
      "sed '1e id' x",
      'sed -s p x',
      'sed -f script.sed x',
      'sed "$S" x',
    ])('asks for %s, whose script writes, runs or cannot be read', async script => {
      expect(await fromProject(script)).toBeNull();
    });

    it.each([
      'echo "$X"',
      'git commit -m "$(cat msg)"',
      'grep "$PAT" src',
      'git diff "$BASE"...HEAD',
      'ls *',
      'ls *.ts',
      'rm -f *.log',
      'mkdir -p src/{a,b}',
      'rm -rf src/x',
      'cp -r src/ out/',
      'grep -rn foo src',
      'grep -r x .',
      "find src -name '*.ts'",
      "cat 'src'/x",
      'sed -n 1,5p src/x',
      "sed -i 's/a/b/g' src/x",
      `awk '{print $1}' src/x`,
      `awk '$1 > 5' src/x`,
    ])('still allows %s from the project', async script => {
      expect(await fromProject(script)).toBe('allow');
    });

    it.each(['ls *', 'rm -f *.log', 'ls *.ts', 'cat ~/proj/src/x'])('still allows %s from home', async script => {
      expect(await decideIn(script, home, join(home, '.config', 'App'), [home])).toBe('allow');
    });

    it.each(['ls .*', 'rm -rf .c*', 'cat ~/.c*/App/x'])(
      'asks for %s from home, which may reach a dot folder',
      async script => {
        expect(await decideIn(script, home, join(home, '.config', 'App'), [home])).toBeNull();
      }
    );
  });

  describe('when a path cannot be resolved', () => {
    let base: string;
    let rules: PermissionRuleSet;

    beforeEach(async () => {
      base = await realpath(await mkdtemp(join(tmpdir(), 'permission-unresolved-')));
      await mkdir(join(base, 'config', 'App'), { recursive: true });
      await mkdir(join(base, 'locked'));
      await symlink(join(base, 'config', 'App'), join(base, 'locked', 'alias'));
      await symlink(join(base, 'loop-a'), join(base, 'loop-b'));
      await symlink(join(base, 'loop-b'), join(base, 'loop-a'));
      rules = set({ allow: [`Edit(/${base}/**)`, 'Bash(cp:*)'] }, [join(base, 'config', 'App')]);
      const native = realpathSync.native;
      vi.spyOn(realpathSync, 'native').mockImplementation((path, options) => {
        if (String(path).startsWith(join(base, 'locked'))) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return native(path, options);
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(base, { recursive: true, force: true });
    });

    it('still allows a resolvable path beside it', () => {
      expect(decide(rules, { tool: 'file_write', paths: [join(base, 'notes.md')] })).toBe('allow');
      expect(rules.coversFolder(join(base, 'notes'))).toBe(true);
    });

    it.each([
      ['EACCES', ['locked', 'alias']],
      ['ELOOP', ['loop-a']],
    ])('treats it as protected on %s', (_code, parts) => {
      const directory = join(base, ...parts);
      const target = join(directory, 'tool-access.json');
      expect(decide(rules, { tool: 'file_write', paths: [target] })).toBeNull();
      const script = `cp x ${target}`;
      const command = { text: script, words: script, coverable: true };
      expect(
        decide(rules, {
          tool: 'bash_execute',
          shell: { script, commands: [command], directories: [], paths: [target] },
        })
      ).toBeNull();
      expect(rules.coversFolder(directory)).toBe(false);
      expect(decide(rules, shell(script, [script], [directory]))).toBeNull();
    });
  });

  describe.each(['darwin', 'win32'] as const)('on %s', platform => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    beforeEach(() => Object.defineProperty(process, 'platform', { value: platform }));
    afterEach(() => {
      if (original) Object.defineProperty(process, 'platform', original);
    });

    it('treats a case variant of a protected folder as the folder', () => {
      const rules = set({ allow: [`Edit(/${HOME}/**)`, 'Bash(cp:*)'] }, [`${HOME}/Library/App`]);
      expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/library/app/tool-access.json`] })).toBeNull();
      const script = `cp x ${HOME}/LIBRARY/APP/tool-access.json`;
      expect(decide(rules, shell(script, [script]))).toBeNull();
      expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/notes.md`] })).toBe('allow');
    });
  });

  describe('on win32, for a protected folder reached through the WSL share', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
    afterEach(() => {
      if (original) Object.defineProperty(process, 'platform', original);
    });

    const APP = 'C:\\Users\\me\\AppData\\Roaming\\App';
    const SHARE = '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\App';

    it('allows an edit elsewhere, so the refusals below come from the protected folder', () => {
      const rules = set({ allow: ['Edit'] }, [APP]);
      expect(decide(rules, { tool: 'file_write', paths: ['D:\\notes'] })).toBe('allow');
      expect(rules.coversFolder('D:\\notes')).toBe(true);
    });

    it('does not allow an edit through the share spelling of the app folder', () => {
      const rules = set({ allow: ['Edit'] }, [APP]);
      expect(decide(rules, { tool: 'file_write', paths: [SHARE] })).toBeNull();
    });

    it('does not cover the share spelling of the app folder as a folder', () => {
      expect(set({ allow: ['Edit'] }, [APP]).coversFolder(SHARE)).toBe(false);
    });

    it('does not allow an edit to a child of the app folder through the share spelling', () => {
      const rules = set({ allow: ['Edit'] }, [APP]);
      expect(decide(rules, { tool: 'file_write', paths: [`${SHARE}\\tool-access.json`] })).toBeNull();
    });

    it.each(['cp x C:/Users/me/AppData/Roaming/App/x', 'cp x /mnt/c/Users/me/AppData/Roaming/App/x'])(
      'does not allow a shell call spelling the app folder as %s',
      script => {
        expect(decide(set({ allow: ['Bash(cp:*)'] }, [APP]), shell(script, [script]))).toBeNull();
      }
    );

    it('still allows a shell call that names an unrelated folder', () => {
      const script = 'cp x D:/notes/x';
      expect(decide(set({ allow: ['Bash(cp:*)'] }, [APP]), shell(script, [script]))).toBe('allow');
    });
  });

  it('keeps the case of a protected folder on linux', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const rules = set({ allow: [`Edit(/${HOME}/**)`] }, [`${HOME}/Library/App`]);
      expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/library/app/x.json`] })).toBe('allow');
      expect(decide(rules, { tool: 'file_write', paths: [`${HOME}/Library/App/x.json`] })).toBeNull();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('does not allow a shell call naming a case variant of a permission file on macOS', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const script = 'cp x .CLAUDE/settings.json';
      expect(decide(set({ allow: ['Bash(cp:*)'] }), shell(script, [script]))).toBeNull();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('never allows an irreversible call, but still denies or asks', () => {
    expect(decide(set({ allow: ['session_delete'] }), { tool: 'session_delete', irreversible: true })).toBeNull();
    expect(decide(set({ deny: ['session_delete'] }), { tool: 'session_delete', irreversible: true })).toBe('deny');
  });

  it.each([
    "sed -i.bak 's/old/new/' alias/settings.local.json",
    "awk -i inplace '{ print }' alias/settings.local.json",
    'dd if=payload of=alias/settings.local.json',
  ])('keeps the permission-file floor for static operands of %s', async script => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'permission-operands-')));
    try {
      await mkdir(join(directory, '.claude'));
      await writeFile(join(directory, '.claude/settings.local.json'), '{}');
      await symlink(join(directory, '.claude'), join(directory, 'alias'));
      const scan = await scanShell(script, directory, [directory]);
      if (!scan) throw new Error('Expected the operand command to parse');
      expect(scan.paths).toContain(join(directory, '.claude/settings.local.json'));
      expect(
        decide(set({ allow: ['Bash'] }), {
          tool: 'bash_execute',
          shell: { script, ...scan },
        })
      ).toBeNull();
      const harmless = "sed 's/old/new/' public.txt";
      const harmlessScan = await scanShell(harmless, directory, [directory]);
      if (!harmlessScan) throw new Error('Expected the harmless command to parse');
      expect(harmlessScan.directories).toEqual([]);
      expect(
        decide(set({ allow: ['Bash'] }), {
          tool: 'bash_execute',
          shell: { script: harmless, ...harmlessScan },
        })
      ).toBe('allow');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches file paths, domains and MCP tools', () => {
    const rules = set({
      allow: ['Read(~/notes/**)', 'WebFetch(domain:*.example.com)', 'mcp__github__search_issues'],
      deny: ['Read(~/.ssh/**)', 'mcp__danger'],
    });
    expect(decide(rules, { tool: 'file_read', paths: [`${HOME}/notes/a.md`] })).toBe('allow');
    expect(decide(rules, { tool: 'grep_search', paths: [`${HOME}/.ssh`] })).toBe('deny');
    expect(decide(rules, { tool: 'web_fetch', host: 'docs.example.com' })).toBe('allow');
    expect(decide(rules, { tool: 'web_fetch', host: 'example.org' })).toBeNull();
    expect(decide(rules, { tool: 'mcp__github_search_issues', mcp: { server: 'github', tool: 'search_issues' } })).toBe(
      'allow'
    );
    expect(decide(rules, { tool: 'mcp__github_create', mcp: { server: 'github', tool: 'create' } })).toBeNull();
    expect(decide(rules, { tool: 'mcp__danger_x', mcp: { server: 'danger', tool: 'x' } })).toBe('deny');
  });

  it('reads a bare WebFetch as every site, beside the domain form', () => {
    expect(parsed('WebFetch').matcher).toEqual({ kind: 'any' });
    const everySite = set({ allow: ['WebFetch'] });
    for (const host of ['docs.example.com', 'example.org', 'pricing.vendor.io']) {
      expect(decide(everySite, { tool: 'web_fetch', host })).toBe('allow');
    }
    expect(decide(everySite, { tool: 'browser_navigate' })).toBeNull();
    const oneSite = set({ allow: ['WebFetch(domain:example.org)'] });
    expect(decide(oneSite, { tool: 'web_fetch', host: 'example.org' })).toBe('allow');
    expect(decide(oneSite, { tool: 'web_fetch', host: 'docs.example.com' })).toBeNull();
    expect(
      decide(set({ allow: ['WebFetch'], deny: ['WebFetch(domain:evil.test)'] }), {
        tool: 'web_fetch',
        host: 'evil.test',
      })
    ).toBe('deny');
  });

  it.each(['deny', 'ask'] as const)('applies %s rules to descendants of recursive searches', list => {
    const rules = set({ allow: ['Read'], [list]: ['Read(/secrets/**)'] });
    for (const tool of ['grep_search', 'glob_files']) {
      expect(decide(rules, { tool, paths: [PROJECT], recursive: true })).toBe(list);
      expect(decide(rules, { tool, paths: [`${PROJECT}/secrets`], recursive: true })).toBe(list);
      expect(decide(rules, { tool, paths: [`${PROJECT}/public`], recursive: true })).toBe('allow');
    }
    expect(decide(rules, { tool: 'file_read', paths: [`${PROJECT}/public.txt`] })).toBe('allow');
  });

  it.each(['Read(.env)', 'Read(/secr*/credentials.json)', 'Read(/private.txt)'])(
    'conservatively refuses an ancestor search that can reach %s',
    rule => {
      expect(
        decide(set({ allow: ['Read'], deny: [rule] }), {
          tool: 'grep_search',
          paths: [PROJECT],
          recursive: true,
        })
      ).toBe('deny');
    }
  );

  it('reports the rule that decided, with its source', () => {
    const verdict = set({ deny: ['Bash(rm:*)'] }).evaluate(shell('rm x', ['rm x']));
    expect(verdict).toMatchObject({ decision: 'deny', rule: { text: 'Bash(rm:*)', source: SOURCE } });
  });
});
