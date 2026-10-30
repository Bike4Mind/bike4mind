import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
