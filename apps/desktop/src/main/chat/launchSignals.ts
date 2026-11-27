import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchSignals } from '@shared/launchSignals';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stats only, never reads: ~/.claude.json can run to megabytes of project history. On macOS
 * Claude Code keeps its login in the keychain, so the config file is the signal there and
 * ~/.claude/.credentials.json is the one on Linux and Windows.
 */
async function hasClaudeCode(home: string): Promise<boolean> {
  const checks = await Promise.all([
    exists(join(home, '.claude.json')),
    exists(join(home, '.claude', '.credentials.json')),
  ]);
  return checks.some(Boolean);
}

/** `.git` is a directory in a clone and a file in a worktree; either counts. */
async function hasRepository(folders: readonly string[]): Promise<boolean> {
  const checks = await Promise.all(folders.map(folder => exists(join(folder, '.git'))));
  return checks.some(Boolean);
}

export async function detectLaunchSignals(input: {
  home: string;
  /** Recent Code folders that still exist (RecentFolderStore.list). */
  recentFolders: () => Promise<readonly { path: string }[]>;
}): Promise<LaunchSignals> {
  const [claudeCode, recentRepository] = await Promise.all([
    hasClaudeCode(input.home),
    input
      .recentFolders()
      .then(folders => hasRepository(folders.map(folder => folder.path)))
      .catch(() => false),
  ]);
  return { claudeCode, recentRepository };
}
