import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLaunchSignals } from './launchSignals';

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launch-signals-'));
  home = join(root, 'home');
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const folders =
  (...paths: string[]) =>
  () =>
    Promise.resolve(paths.map(path => ({ path })));

describe('detectLaunchSignals', () => {
  it('finds nothing on a bare machine', async () => {
    await expect(detectLaunchSignals({ home, recentFolders: folders() })).resolves.toEqual({
      claudeCode: false,
      recentRepository: false,
    });
  });

  it('counts the Claude Code config file', async () => {
    await writeFile(join(home, '.claude.json'), '{}');
    const signals = await detectLaunchSignals({ home, recentFolders: folders() });
    expect(signals.claudeCode).toBe(true);
  });

  it('counts the Claude Code credentials file', async () => {
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude', '.credentials.json'), '{}');
    const signals = await detectLaunchSignals({ home, recentFolders: folders() });
    expect(signals.claudeCode).toBe(true);
  });

  it('counts a recent folder that is a clone or a worktree, not a plain folder', async () => {
    const plain = join(root, 'plain');
    const clone = join(root, 'clone');
    const worktree = join(root, 'worktree');
    await mkdir(plain);
    await mkdir(join(clone, '.git'), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere');

    expect((await detectLaunchSignals({ home, recentFolders: folders(plain) })).recentRepository).toBe(false);
    expect((await detectLaunchSignals({ home, recentFolders: folders(plain, clone) })).recentRepository).toBe(true);
    expect((await detectLaunchSignals({ home, recentFolders: folders(worktree) })).recentRepository).toBe(true);
  });

  it('treats an unreadable recent-folder list as no repository', async () => {
    const signals = await detectLaunchSignals({ home, recentFolders: () => Promise.reject(new Error('corrupt')) });
    expect(signals.recentRepository).toBe(false);
  });
});
