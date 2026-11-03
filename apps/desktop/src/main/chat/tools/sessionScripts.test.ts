import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  expectShellRun,
  forgetSessionWrites,
  gitRunsConfiguredProgram,
  recordSessionTreeWrite,
  recordSessionWrite,
  sessionScriptRun,
  shellCommandRan,
} from './sessionScripts';
import type { ToolContext } from './types';

const WRITTEN = [
  'setup.sh',
  'sub/y.sh',
  'run.sh',
  'tools/go.py',
  'tools/x.ts',
  'tools/hook.js',
  'web/package.json',
  'Makefile',
  'vitest.config.ts',
  'src/a.test.ts',
  'tests/test_a.py',
  'py/tests/conftest.py',
  'rs/build.rs',
  'justfile',
  'Taskfile.yml',
  'cfg/custom.config.ts',
  'plugins/myplug.py',
];

describe('sessionScriptRun', () => {
  let root: string;
  const session = 'session-scripts-test';
  const context = { sessionId: session } as ToolContext;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-session-scripts-')));
    for (const directory of [
      'tools',
      'sub',
      'web',
      'src',
      'tests',
      'py/tests',
      'rs',
      'cfg',
      'plugins',
      'repo/.git/hooks',
      'repo/sub',
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const file of [...WRITTEN, 'data.txt']) {
      await writeFile(join(root, file), 'x\n', 'utf8');
      if (file !== 'data.txt') await recordSessionWrite(context, join(root, file));
    }
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  const runs = async (command: string, sessionId = session) =>
    (await sessionScriptRun(command, root, sessionId))?.names ?? null;

  it.each([
    ['bash setup.sh', 'setup.sh'],
    ['./setup.sh', './setup.sh'],
    ['ROOT/setup.sh --flag', 'ROOT/setup.sh'],
    ['. ./setup.sh', './setup.sh'],
    ['sudo -E bash setup.sh', 'setup.sh'],
    ['sudo -u bob bash setup.sh', 'setup.sh'],
    ['timeout 5 python3 -u tools/go.py', 'tools/go.py'],
    ['env A=1 python3 tools/go.py', 'tools/go.py'],
    ['cd tools && python go.py', 'go.py'],
    ['bash < setup.sh', 'setup.sh'],
    ['cat setup.sh | sh', 'setup.sh'],
    ['bash -lc "bash setup.sh"', 'setup.sh'],
    ['echo ok; (bash setup.sh)', 'setup.sh'],
    ['make build', 'Makefile'],
    ['npx tsx tools/x.ts', 'tools/x.ts'],
    ['bunx tsx tools/x.ts', 'tools/x.ts'],
    ['pnpm exec tsx tools/x.ts', 'tools/x.ts'],
    ['pnpm dlx tsx tools/x.ts', 'tools/x.ts'],
    ['yarn dlx tsx tools/x.ts', 'tools/x.ts'],
    ['uv run python tools/go.py', 'tools/go.py'],
    ['poetry run python tools/go.py', 'tools/go.py'],
    ['node --require=./tools/hook.js app.js', './tools/hook.js'],
    ['NODE_OPTIONS=--require=./tools/hook.js node app.js', './tools/hook.js'],
    ['NODE_OPTIONS="--require ./tools/hook.js" node app.js', './tools/hook.js'],
    ['npx vitest run', 'vitest.config.ts'],
    ['vitest', 'vitest.config.ts'],
    ['pytest', 'py/tests/conftest.py'],
    ['cd rs && cargo build', 'rs/build.rs'],
    ['just test', 'justfile'],
    ['task build', 'Taskfile.yml'],
    ['python3 tools/go.py -m pytest', 'tools/go.py'],
    ['uv run tools/go.py', 'tools/go.py'],
    ['vitest --config cfg/custom.config.ts', 'cfg/custom.config.ts'],
    ['npx jest -c cfg/custom.config.ts', 'cfg/custom.config.ts'],
    ['pnpm vitest --config=cfg/custom.config.ts', 'cfg/custom.config.ts'],
    ['pytest -p plugins.myplug', 'plugins/myplug.py'],
    ['git -c core.editor=./tools/hook.js commit', './tools/hook.js'],
    ['bash -c "cd sub && ./y.sh"', './y.sh'],
    ['bash -c "cd sub; bash y.sh"', 'y.sh'],
    ['bash +ec "cd sub; bash y.sh"', 'y.sh'],
    ['echo "$(./run.sh)"', './run.sh'],
    ['echo "$(bash run.sh)"', 'run.sh'],
    ['bash <(cat run.sh)', 'run.sh'],
    ['cat run.sh | sudo bash', 'run.sh'],
    ['cat run.sh | env bash', 'run.sh'],
    ["git -c alias.z='!sh run.sh' z", 'run.sh'],
    ['/usr/bin/git -c core.hooksPath=./run.sh commit', './run.sh'],
  ])('finds %s', async (command, name) => {
    expect(await runs(command.replace('ROOT', root))).toContain(name.replace('ROOT', root));
  });

  it('matches a written file in the home folder given as ~', async () => {
    const script = join(homedir(), 'b4m-session-scripts-nonexistent.sh');
    await recordSessionWrite(context, script);
    expect(await runs('bash ~/b4m-session-scripts-nonexistent.sh')).toHaveLength(1);
    expect(await runs('cd ~ && bash b4m-session-scripts-nonexistent.sh')).toEqual([
      'b4m-session-scripts-nonexistent.sh',
    ]);
  });

  it.each(['cd web && npm run build', 'pnpm --dir web test', 'yarn --cwd web build'])(
    'finds the package.json %s reads',
    async command => {
      expect(await runs(command)).toEqual(['web/package.json']);
    }
  );

  it.each([
    'cat setup.sh',
    'git add setup.sh tools/go.py',
    'git status',
    'chmod +x setup.sh',
    'npm test',
    'cd tools && npm test',
    'python3 -c "print(1)"',
    'bash data.txt',
    'grep x setup.sh | wc -l',
    'bash $SCRIPT',
    'cd src && npx vitest run a.test.ts',
    'cd tests && python -m pytest test_a.py',
    'npx prettier --write tools/x.ts',
    'npx eslint tools/x.ts',
    'npx tsc -p tools/x.ts',
    'pnpm exec eslint tools/x.ts',
    'echo "$(cat run.sh)"',
    'diff <(cat run.sh) data.txt',
    'cat run.sh | sudo tee out.txt',
  ])('ignores %s', async command => {
    expect(await runs(command)).toBeNull();
  });

  it('only counts files the same session wrote', async () => {
    expect(await runs('bash setup.sh', 'another-session')).toBeNull();
  });

  it('changes the generation when the script is written again', async () => {
    const before = await sessionScriptRun('bash setup.sh', root, session);
    await recordSessionWrite(context, join(root, 'setup.sh'));
    const after = await sessionScriptRun('bash setup.sh', root, session);
    expect(after?.generation).not.toBe(before?.generation);
  });

  it('flags git in a repository whose hooks were written until an approved run', async () => {
    const id = 'session-scripts-hooks';
    const repo = join(root, 'repo');
    await recordSessionWrite({ sessionId: id } as ToolContext, join(repo, '.git/hooks/pre-commit'));

    const run = await sessionScriptRun('git commit -m x', repo, id);
    expect(run?.hooks.map(([repository]) => repository)).toEqual([repo]);
    expect(await sessionScriptRun('git status', root, id)).toBeNull();
    expect(await sessionScriptRun(`git -C ${repo} status`, root, id)).not.toBeNull();

    expectShellRun('key', id, run!.hooks);
    shellCommandRan({ sessionId: id, approvedKey: 'key' } as ToolContext);
    expect(await sessionScriptRun('git status', repo, id)).toBeNull();
  });

  it('flags git in the enclosing repository after a config write from a subfolder', async () => {
    const id = 'session-scripts-subfolder';
    const repo = join(root, 'repo');
    await recordSessionWrite({ sessionId: id } as ToolContext, join(repo, 'sub', '.git', 'config'));
    expect((await sessionScriptRun('git status', repo, id))?.hooks).toEqual([[repo, expect.any(Number)]]);
  });

  it('flags git everywhere after a write to the global git config', async () => {
    const id = 'session-scripts-global';
    await recordSessionWrite({ sessionId: id } as ToolContext, join(root, 'home', '.gitconfig'));
    expect((await sessionScriptRun('git status', join(root, 'tools'), id))?.hooks).toHaveLength(1);
  });

  it('flags git after a write under .husky', async () => {
    const id = 'session-scripts-husky';
    await recordSessionWrite({ sessionId: id } as ToolContext, join(root, 'repo', '.husky', 'pre-push'));
    expect((await sessionScriptRun('git push', join(root, 'repo'), id))?.hooks).toHaveLength(1);
  });

  it('asks before any script run once more files were written than it keeps', async () => {
    const id = 'session-scripts-overflow';
    for (let index = 0; index <= 200; index++) {
      await recordSessionWrite({ sessionId: id } as ToolContext, join(root, `gen-${index}.txt`));
    }
    const run = await sessionScriptRun('bash data.txt', root, id);
    expect(run).toMatchObject({ names: ['data.txt'], untracked: true });
    expect(await sessionScriptRun('git status', root, id)).toBeNull();
  });

  it('treats a session whose records were evicted as overflowed', async () => {
    const id = 'session-scripts-evicted';
    await recordSessionWrite({ sessionId: id } as ToolContext, join(root, 'nothing.txt'));
    for (let index = 0; index < 50; index++) {
      await recordSessionWrite({ sessionId: `filler-${index}` } as ToolContext, join(root, 'nothing.txt'));
    }
    expect(await sessionScriptRun('bash data.txt', root, id)).toMatchObject({ untracked: true });
    for (let index = 0; index < 50; index++) forgetSessionWrites(`filler-${index}`);
    forgetSessionWrites(id);
    forgetSessionWrites(session);
  });

  it('counts a file under a rewritten folder as written', async () => {
    const id = 'session-scripts-tree';
    await recordSessionTreeWrite({ sessionId: id } as ToolContext, join(root, 'tools'));
    expect(await runs('python3 tools/go.py', id)).toEqual(['tools/go.py']);
    expect(await runs('bash data.txt', id)).toBeNull();
    expect(await runs('cd tools && ./missing.sh', id)).toBeNull();
  });

  it('flags git after a folder holding a repository is rewritten', async () => {
    const id = 'session-scripts-tree-hooks';
    await recordSessionTreeWrite({ sessionId: id } as ToolContext, join(root, 'repo'));
    expect((await sessionScriptRun('git status', join(root, 'repo'), id))?.hooks).toHaveLength(1);
  });

  it('forgets a closed session', async () => {
    const id = 'session-scripts-closed';
    await recordSessionWrite({ sessionId: id } as ToolContext, join(root, 'setup.sh'));
    forgetSessionWrites(id);
    expect(await sessionScriptRun('bash setup.sh', root, id)).toBeNull();
  });
});

describe('session writes across a restart', () => {
  let root: string;
  const saved = new Map<string, unknown>();
  const store = {
    loadSessionWrites: async (id: string) => saved.get(id) ?? null,
    saveSessionWrites: async (id: string, writes: unknown) => void saved.set(id, structuredClone(writes)),
    deleteSessionWrites: async (id: string) => void saved.delete(id),
  };

  /** A fresh copy of the module, as after an app restart, reading the same store. */
  const relaunch = async () => {
    vi.resetModules();
    const fresh = await import('./sessionScripts');
    fresh.keepSessionWritesIn(store);
    return fresh;
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-session-restart-')));
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'setup.sh'), 'x\n', 'utf8');
    await writeFile(join(root, 'out', 'run.sh'), 'x\n', 'utf8');
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it('still asks in a resumed session, with the same generation', async () => {
    const before = await relaunch();
    const context = { sessionId: 'restart' } as ToolContext;
    await before.recordSessionWrite(context, join(root, 'setup.sh'));
    await before.recordSessionTreeWrite(context, join(root, 'out'));
    const first = await before.sessionScriptRun('bash setup.sh && bash out/run.sh', root, 'restart');

    const after = await relaunch();
    const resumed = await after.sessionScriptRun('bash setup.sh && bash out/run.sh', root, 'restart');
    expect(resumed?.names).toEqual(['setup.sh', 'out/run.sh']);
    expect(resumed?.generation).toBe(first?.generation);
    expect(await after.sessionScriptRun('bash setup.sh', root, 'other')).toBeNull();

    await after.recordSessionWrite(context, join(root, 'setup.sh'));
    expect((await after.sessionScriptRun('bash setup.sh', root, 'restart'))?.generation).not.toBe(first?.generation);
  });

  it('asks before any script run when the stored record does not read back', async () => {
    saved.set('corrupt', { files: 'nope' });
    const after = await relaunch();
    expect(await after.sessionScriptRun('bash setup.sh', root, 'corrupt')).toMatchObject({ untracked: true });
  });

  it('removes the stored record when the session is deleted', async () => {
    const before = await relaunch();
    await before.recordSessionWrite({ sessionId: 'deleted' } as ToolContext, join(root, 'setup.sh'));
    await before.forgetSessionWrites('deleted');
    expect(saved.has('deleted')).toBe(false);
    expect(await (await relaunch()).sessionScriptRun('bash setup.sh', root, 'deleted')).toBeNull();
  });
});

describe('gitRunsConfiguredProgram', () => {
  it.each([
    ['git -c core.fsmonitor=./x status', 'core.fsmonitor'],
    ["git -c 'core.hooksPath=h' commit", 'core.hookspath'],
    ['sudo git -c core.sshCommand=ssh push', 'core.sshcommand'],
  ])('flags %s', (command, key) => {
    expect(gitRunsConfiguredProgram([{ words: command }])?.toLowerCase()).toBe(key);
  });

  it.each(['git status', 'git -c color.ui=never log', 'echo -c core.fsmonitor=x'])('ignores %s', command => {
    expect(gitRunsConfiguredProgram([{ words: command }])).toBeNull();
  });
});
