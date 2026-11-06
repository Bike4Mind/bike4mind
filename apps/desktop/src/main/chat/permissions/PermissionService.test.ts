import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeSettings } from './ClaudeCodeSettings';
import { PermissionRuleStore } from './PermissionRuleStore';
import { PermissionService } from './PermissionService';
import type { PermissionSubject } from './rules';

const bash = (command: string): PermissionSubject => ({
  tool: 'bash_execute',
  shell: { script: command, commands: [{ text: command, words: command, coverable: true }], directories: [] },
});

async function writeSettings(path: string, permissions: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ permissions }), 'utf8');
}

/**
 * Save until the watcher has picked the change up. macOS can drop an event that lands within
 * milliseconds of a watch starting, which a person editing the file never hits; saving again is
 * what an editor would do.
 */
async function savedUntil(
  path: string,
  permissions: Record<string, unknown>,
  applied: () => Promise<boolean>,
  { recreateFolder = false } = {}
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // A dropped mkdir event is only seen again if the folder is made again.
    if (recreateFolder) await rm(join(path, '..'), { recursive: true, force: true });
    await writeSettings(path, permissions);
    const until = Date.now() + 500;
    while (Date.now() < until) {
      if (await applied()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`${path} was never reloaded`);
}

describe('PermissionService', () => {
  let home: string;
  let project: string;
  let userData: string;
  let managedPath: string;
  let trusted: Set<string>;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  let claudeCode: ClaudeCodeSettings;
  let service: PermissionService;
  let changes: number;

  const build = () => {
    claudeCode = new ClaudeCodeSettings({
      home,
      managedPath,
      logger: { warn },
      debounceMs: 20,
      onChange: () => {
        changes++;
        service.invalidate();
      },
    });
    service = new PermissionService({
      store: new PermissionRuleStore(join(userData, 'permission-rules.json')),
      claudeCode,
      isTrusted: async directory => trusted.has(directory),
      home,
      protectedRoots: [userData, join(home, '.claude')],
      logger: { warn },
    });
  };

  const decide = async (subject: PermissionSubject, scope = { project, workingDirectory: project }) =>
    (await service.rulesFor(scope)).evaluate(subject);

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-permissions-')));
    home = join(root, 'home');
    project = join(root, 'project');
    userData = join(root, 'userData');
    managedPath = join(root, 'managed', 'managed-settings.json');
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    trusted = new Set();
    warn = vi.fn<(message: string) => void>();
    changes = 0;
    build();
  });

  afterEach(async () => {
    claudeCode.dispose();
    await rm(join(home, '..'), { recursive: true, force: true });
  });

  it('applies Claude Code user rules, deny over ask over allow across every source', async () => {
    await writeSettings(join(home, '.claude', 'settings.json'), {
      allow: ['Bash(git status:*)', 'Bash(rm:*)'],
      ask: ['Bash(git push:*)'],
    });
    await writeSettings(managedPath, { deny: ['Bash(rm:*)'] });
    await service.start();
    await service.setRules({ kind: 'user' }, { allow: ['Bash(git push:*)'], ask: [], deny: ['Bash(git status:*)'] });

    expect(await decide(bash('rm x'))).toMatchObject({ decision: 'deny', rule: { source: { id: 'cc-managed' } } });
    expect(await decide(bash('git push'))).toMatchObject({ decision: 'ask', rule: { source: { id: 'cc-user' } } });
    expect(await decide(bash('git status'))).toMatchObject({
      decision: 'deny',
      rule: { source: { id: 'desktop-user' } },
    });
  });

  it('loads imported user sources for a settings snapshot before start finishes', async () => {
    await writeSettings(join(home, '.claude', 'settings.json'), { deny: ['Bash(rm:*)'] });
    const state = await service.state();
    expect(state.claudeCode.find(source => source.id === 'cc-user')).toMatchObject({
      status: 'loaded',
      rules: [{ rule: 'Bash(rm:*)', list: 'deny' }],
    });
  });

  it('reads the user local file and keeps desktop project rules to their project', async () => {
    await writeSettings(join(home, '.claude', 'settings.local.json'), { allow: ['Bash(gh pr view:*)'] });
    await service.start();
    await service.setRules({ kind: 'project', directory: project }, { allow: ['Bash(make:*)'], ask: [], deny: [] });

    expect((await decide(bash('gh pr view 1'))).decision).toBe('allow');
    expect((await decide(bash('make test'))).decision).toBe('allow');
    expect((await decide(bash('make test'), { project: home, workingDirectory: home })).decision).toBeNull();
  });

  it("ignores an untrusted project's allows but keeps its denies and asks", async () => {
    await writeSettings(join(project, '.claude', 'settings.json'), {
      allow: ['Bash(curl:*)'],
      deny: ['Bash(rm:*)'],
      ask: ['Bash(git push:*)'],
    });
    await writeSettings(join(project, '.claude', 'settings.local.json'), { allow: ['Bash(npm publish:*)'] });
    await service.start();

    expect((await decide(bash('curl https://example.com'))).decision).toBeNull();
    expect((await decide(bash('npm publish'))).decision).toBeNull();
    expect((await decide(bash('rm x'))).decision).toBe('deny');
    expect((await decide(bash('git push'))).decision).toBe('ask');
    expect((await service.state()).claudeCode.find(source => source.id === `cc-project:${project}`)?.note).toMatch(
      /not trusted/
    );

    trusted.add(project);
    service.invalidate();
    expect((await decide(bash('curl https://example.com'))).decision).toBe('allow');
    expect((await decide(bash('npm publish'))).decision).toBe('allow');
  });

  it('stops applying Claude Code rules when sharing is off', async () => {
    await writeSettings(join(home, '.claude', 'settings.json'), { allow: ['Bash(ls:*)'] });
    await service.start();
    expect((await decide(bash('ls'))).decision).toBe('allow');

    await service.setShareClaudeCode(false);
    expect((await decide(bash('ls'))).decision).toBeNull();
    expect((await service.state()).shareClaudeCode).toBe(false);
  });

  it('logs an entry that does not parse or map once, and applies the rest', async () => {
    await writeSettings(join(home, '.claude', 'settings.json'), { allow: ['Task', 'Bash(ls:*)', 'Bash()'] });
    await service.start();
    expect((await decide(bash('ls'))).decision).toBe('allow');
    service.invalidate();
    await decide(bash('ls'));

    expect(warn).toHaveBeenCalledTimes(2);
    const view = (await service.state()).claudeCode.find(source => source.id === 'cc-user');
    expect(view?.rules.filter(rule => rule.problem).map(rule => rule.rule)).toEqual(['Task', 'Bash()']);
  });

  it('compiles once per project until something changes', async () => {
    await service.start();
    const first = service.rulesFor({ project, workingDirectory: project });
    expect(service.rulesFor({ project, workingDirectory: project })).toBe(first);
    service.invalidate();
    expect(service.rulesFor({ project, workingDirectory: project })).not.toBe(first);
  });

  it('reloads a watched Claude Code file after an edit, with no restart', async () => {
    await writeSettings(join(home, '.claude', 'settings.json'), { allow: [] });
    await service.start();
    expect((await decide(bash('git log'))).decision).toBeNull();

    await savedUntil(
      join(home, '.claude', 'settings.json'),
      { allow: ['Bash(git log:*)'] },
      async () => changes > 0 && (await decide(bash('git log'))).decision === 'allow'
    );
    expect((await decide(bash('git log'))).decision).toBe('allow');
  });

  it("starts watching a project's .claude folder once it is created", async () => {
    trusted.add(project);
    await service.start();
    expect((await decide(bash('make'))).decision).toBeNull();

    await savedUntil(
      join(project, '.claude', 'settings.json'),
      { allow: ['Bash(make:*)'] },
      async () => (await decide(bash('make'))).decision === 'allow',
      { recreateFolder: true }
    );
  });

  it('refuses compilation when an imported rule source is unreadable', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), '{broken');
    await service.start();
    await service.setRules({ kind: 'user' }, { allow: ['Bash(rm:*)'], ask: [], deny: [] });
    await expect(decide(bash('rm x'))).rejects.toThrow('Cannot read permission rules');
  });

  it('refuses a rule that does not parse, and saves nothing', async () => {
    const result = await service.setRules({ kind: 'user' }, { allow: ['Bash(ls:*)', 'Nope(x)'], ask: [], deny: [] });
    expect(result.ok).toBe(false);
    expect((await service.state()).user).toEqual([]);
  });

  it('saves the rules an approval card derived as user-level allows', async () => {
    await service.rememberAllows(['Bash(gh pr create:*)', 'not a rule!']);
    expect((await decide(bash('gh pr create --fill'))).decision).toBe('allow');
    expect((await service.state()).user).toEqual([{ rule: 'Bash(gh pr create:*)', list: 'allow' }]);
  });

  it('revokes one user allow, keeping the other lists and the compiled rules current', async () => {
    await service.setRules({ kind: 'user' }, { allow: ['Bash(ls:*)', 'Bash(pwd)'], ask: ['Bash(ls:*)'], deny: [] });
    expect((await decide(bash('pwd'))).decision).toBe('allow');
    expect(await service.revokeAllow({ kind: 'user' }, 'Bash(pwd)')).toBe(true);
    expect((await decide(bash('pwd'))).decision).toBeNull();
    expect((await service.state()).user).toEqual([
      { rule: 'Bash(ls:*)', list: 'allow' },
      { rule: 'Bash(ls:*)', list: 'ask' },
    ]);
  });

  it("revokes a project allow only from that project's rules", async () => {
    await service.setRules({ kind: 'user' }, { allow: ['Bash(pwd)'], ask: [], deny: [] });
    await service.setRules({ kind: 'project', directory: project }, { allow: ['Bash(pwd)'], ask: [], deny: [] });
    expect(await service.revokeAllow({ kind: 'project', directory: project }, 'Bash(pwd)')).toBe(true);
    const stored = await new PermissionRuleStore(join(userData, 'permission-rules.json')).read();
    expect(stored.user.allow).toEqual(['Bash(pwd)']);
    expect(stored.projects[project]?.allow ?? []).toEqual([]);
  });

  it('leaves a project with no stored rules unchanged when revoking from it', async () => {
    expect(await service.revokeAllow({ kind: 'project', directory: project }, 'Bash(pwd)')).toBe(false);
    const stored = await new PermissionRuleStore(join(userData, 'permission-rules.json')).read();
    expect(stored.projects[project]?.allow ?? []).toEqual([]);
  });
});

describe('PermissionRuleStore', () => {
  it('round-trips through the file, written owner-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b4m-rule-store-'));
    const path = join(dir, 'permission-rules.json');
    const store = new PermissionRuleStore(path);
    await store.setLists({ kind: 'user' }, { allow: ['Bash(ls:*)', 'Bash(ls:*)'], ask: ['WebSearch'], deny: [] });
    await store.setLists({ kind: 'project', directory: '/work/x' }, { allow: [], ask: [], deny: ['Bash(rm:*)'] });
    await store.setShareClaudeCode(false);

    const reread = await new PermissionRuleStore(path).read();
    expect(reread).toEqual({
      shareClaudeCode: false,
      user: { allow: ['Bash(ls:*)'], ask: ['WebSearch'], deny: [] },
      projects: { '/work/x': { allow: [], ask: [], deny: ['Bash(rm:*)'] } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).shareClaudeCode).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('serializes concurrent changes without losing rules or sharing preferences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b4m-rule-store-'));
    try {
      const path = join(dir, 'permission-rules.json');
      const store = new PermissionRuleStore(path);
      await Promise.all([
        store.addUserAllows(['Bash(ls:*)']),
        store.addUserAllows(['Bash(git status:*)']),
        store.setShareClaudeCode(false),
        store.setLists({ kind: 'project', directory: '/work/x' }, { allow: [], ask: [], deny: ['Bash(rm:*)'] }),
      ]);
      expect(await new PermissionRuleStore(path).read()).toMatchObject({
        shareClaudeCode: false,
        user: { allow: ['Bash(ls:*)', 'Bash(git status:*)'] },
        projects: { '/work/x': { deny: ['Bash(rm:*)'] } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the last committed permissions after a failed save and can retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b4m-rule-store-'));
    try {
      const path = join(dir, 'permission-rules.json');
      const store = new PermissionRuleStore(path);
      await store.setShareClaudeCode(false);
      await mkdir(`${path}.tmp`);
      await expect(store.addUserAllows(['Bash(rm:*)'])).rejects.toThrow();
      expect(await store.read()).toMatchObject({ shareClaudeCode: false, user: { allow: [] } });
      await rm(`${path}.tmp`, { recursive: true });
      await store.addUserAllows(['Bash(ls:*)']);
      expect(await new PermissionRuleStore(path).read()).toMatchObject({ user: { allow: ['Bash(ls:*)'] } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults only for a missing file and rejects corrupt rules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b4m-rule-store-'));
    await writeFile(join(dir, 'bad.json'), '{not json', 'utf8');
    for (const name of ['missing.json']) {
      expect(await new PermissionRuleStore(join(dir, name)).read()).toEqual({
        shareClaudeCode: true,
        user: { allow: [], ask: [], deny: [] },
        projects: {},
      });
    }
    await expect(new PermissionRuleStore(join(dir, 'bad.json')).read()).rejects.toThrow();
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ user: { deny: 'Bash(rm:*)' } }));
    await expect(new PermissionRuleStore(join(dir, 'bad.json')).read()).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});
