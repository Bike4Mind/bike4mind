/**
 * Tests for CheckpointStore
 *
 * Tests checkpoint creation, listing, restoration, diffing, and pruning.
 * Uses a real temporary directory with actual git operations for integration testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointStore } from './CheckpointStore';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

// Use real filesystem for integration tests
let testDir: string;
let checkpointStore: CheckpointStore;
const sessionId = 'test-session-123';

/**
 * Create a temp directory with git init for realistic testing
 */
async function createTestProject(): Promise<string> {
  const dir = path.join(tmpdir(), `b4m-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });

  // Initialize a git repo so .gitignore management works
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });

  return dir;
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('CheckpointStore', () => {
  beforeEach(async () => {
    testDir = await createTestProject();
    checkpointStore = new CheckpointStore(testDir);
    await checkpointStore.init(sessionId);
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  describe('init', () => {
    it('should create .b4m/shadow-repo with a git repo', () => {
      const shadowGit = path.join(testDir, '.b4m', 'shadow-repo', '.git');
      expect(existsSync(shadowGit)).toBe(true);
    });

    it('should create checkpoints.json after first checkpoint', async () => {
      const metadataPath = path.join(testDir, '.b4m', 'checkpoints.json');
      // Metadata file is lazily created on first checkpoint
      expect(existsSync(metadataPath)).toBe(false);

      await fs.writeFile(path.join(testDir, 'test.ts'), 'content', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['test.ts']);

      expect(existsSync(metadataPath)).toBe(true);
    });

    it('should add .b4m/ to .gitignore', async () => {
      const gitignorePath = path.join(testDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');
      expect(content).toContain('.b4m/');
    });

    it('should not duplicate .gitignore entry on re-init', async () => {
      // Re-init should not add duplicate entry
      const store2 = new CheckpointStore(testDir);
      await store2.init('session-2');

      const gitignorePath = path.join(testDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');
      const matches = content.match(/\.b4m\//g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('createCheckpoint', () => {
    it('should snapshot an existing file before modification', async () => {
      // Create a file in the project
      const filePath = 'src/hello.ts';
      await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(testDir, filePath), 'const x = 1;', 'utf-8');

      const checkpoint = await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.toolName).toBe('edit_local_file');
      expect(checkpoint!.filePaths).toEqual([filePath]);
      expect(checkpoint!.sessionId).toBe(sessionId);
      expect(checkpoint!.name).toContain('before-edit_local_file');
    });

    it('should record absent marker for non-existent files', async () => {
      // File does not exist yet (will be created by create_file)
      const filePath = 'new-file.ts';

      const checkpoint = await checkpointStore.createCheckpoint('create_file', [filePath]);

      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.toolName).toBe('create_file');
    });

    it('should return null when not initialized', async () => {
      const uninitStore = new CheckpointStore(testDir);
      // Don't call init
      const result = await uninitStore.createCheckpoint('create_file', ['test.ts']);
      expect(result).toBeNull();
    });

    it('should skip files larger than 10MB', async () => {
      const filePath = 'large-file.bin';
      // Create a file > 10MB
      const largeContent = Buffer.alloc(11 * 1024 * 1024, 'x');
      await fs.writeFile(path.join(testDir, filePath), largeContent);

      const checkpoint = await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      // Should return null because the large file was skipped and no changes were staged
      expect(checkpoint).toBeNull();
    });
  });

  describe('listCheckpoints', () => {
    it('should return empty array when no checkpoints exist', () => {
      const checkpoints = checkpointStore.listCheckpoints();
      expect(checkpoints).toEqual([]);
    });

    it('should return checkpoints in reverse chronological order', async () => {
      await fs.writeFile(path.join(testDir, 'file1.ts'), 'content1', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file1.ts']);

      await fs.writeFile(path.join(testDir, 'file2.ts'), 'content2', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file2.ts']);

      const checkpoints = checkpointStore.listCheckpoints();
      expect(checkpoints).toHaveLength(2);
      // Most recent first
      expect(checkpoints[0].filePaths).toEqual(['file2.ts']);
      expect(checkpoints[1].filePaths).toEqual(['file1.ts']);
    });

    it('should only return checkpoints for current session', async () => {
      await fs.writeFile(path.join(testDir, 'file1.ts'), 'content1', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file1.ts']);

      // Switch session
      checkpointStore.setSessionId('other-session');
      await fs.writeFile(path.join(testDir, 'file2.ts'), 'content2', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file2.ts']);

      // Only the second checkpoint should be visible
      const checkpoints = checkpointStore.listCheckpoints();
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].filePaths).toEqual(['file2.ts']);
    });
  });

  describe('restoreCheckpoint', () => {
    it('should restore file to its state at checkpoint time', async () => {
      const filePath = 'src/app.ts';
      await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
      const originalContent = 'const app = "original";';
      await fs.writeFile(path.join(testDir, filePath), originalContent, 'utf-8');

      // Create checkpoint (snapshots original content)
      await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      // Simulate tool modifying the file
      await fs.writeFile(path.join(testDir, filePath), 'const app = "modified";', 'utf-8');

      // Restore
      const restored = await checkpointStore.restoreCheckpoint(1);
      expect(restored.filePaths).toEqual([filePath]);

      // Verify file content restored
      const restoredContent = await fs.readFile(path.join(testDir, filePath), 'utf-8');
      expect(restoredContent).toBe(originalContent);
    });

    it('should delete file if it was absent at checkpoint time', async () => {
      const filePath = 'new-file.ts';

      // Create checkpoint for non-existent file
      await checkpointStore.createCheckpoint('create_file', [filePath]);

      // Simulate create_file tool creating it
      await fs.writeFile(path.join(testDir, filePath), 'new content', 'utf-8');
      expect(existsSync(path.join(testDir, filePath))).toBe(true);

      // Restore should delete the file
      await checkpointStore.restoreCheckpoint(1);
      expect(existsSync(path.join(testDir, filePath))).toBe(false);
    });

    it('should throw for invalid checkpoint index', async () => {
      await expect(checkpointStore.restoreCheckpoint(99)).rejects.toThrow('Checkpoint #99 not found');
    });
  });

  describe('undoLast', () => {
    it('should restore to most recent checkpoint', async () => {
      const filePath = 'test.ts';
      await fs.writeFile(path.join(testDir, filePath), 'original', 'utf-8');
      await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      await fs.writeFile(path.join(testDir, filePath), 'modified', 'utf-8');

      const restored = await checkpointStore.undoLast();
      expect(restored.filePaths).toEqual([filePath]);

      const content = await fs.readFile(path.join(testDir, filePath), 'utf-8');
      expect(content).toBe('original');
    });

    it('should throw when no checkpoints exist', async () => {
      await expect(checkpointStore.undoLast()).rejects.toThrow('Checkpoint #1 not found');
    });
  });

  describe('getCheckpointDiff', () => {
    it('should return diff when file has changed since checkpoint', async () => {
      const filePath = 'test.ts';
      await fs.writeFile(path.join(testDir, filePath), 'line1\nline2\n', 'utf-8');
      await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      // Modify file
      await fs.writeFile(path.join(testDir, filePath), 'line1\nline2\nline3\n', 'utf-8');

      const diff = checkpointStore.getCheckpointDiff(1);
      expect(diff).toContain('line3');
    });

    it('should return empty string when no changes', async () => {
      const filePath = 'test.ts';
      await fs.writeFile(path.join(testDir, filePath), 'unchanged', 'utf-8');
      await checkpointStore.createCheckpoint('edit_local_file', [filePath]);

      // Don't modify the file
      const diff = checkpointStore.getCheckpointDiff(1);
      expect(diff.trim()).toBe('');
    });

    it('should throw for invalid checkpoint index', () => {
      expect(() => checkpointStore.getCheckpointDiff(99)).toThrow('Checkpoint #99 not found');
    });
  });

  describe('pruneCheckpoints', () => {
    it('should keep only the specified number of checkpoints', async () => {
      // Create 5 checkpoints
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(testDir, `file${i}.ts`), `content${i}`, 'utf-8');
        await checkpointStore.createCheckpoint('create_file', [`file${i}.ts`]);
      }

      // Prune to keep 2
      await checkpointStore.pruneCheckpoints(2);

      // All 5 are in the same session, but metadata should only have 2
      const checkpoints = checkpointStore.listCheckpoints();
      expect(checkpoints).toHaveLength(2);
      // Should keep the most recent ones
      expect(checkpoints[0].filePaths).toEqual(['file4.ts']);
      expect(checkpoints[1].filePaths).toEqual(['file3.ts']);
    });
  });

  describe('cleanup', () => {
    it('should remove the shadow repo and metadata', async () => {
      await checkpointStore.cleanup();

      expect(existsSync(path.join(testDir, '.b4m', 'shadow-repo'))).toBe(false);
      expect(existsSync(path.join(testDir, '.b4m', 'checkpoints.json'))).toBe(false);
    });
  });

  describe('setSessionId', () => {
    it('should scope new checkpoints to the updated session', async () => {
      await fs.writeFile(path.join(testDir, 'file1.ts'), 'content1', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file1.ts']);

      checkpointStore.setSessionId('new-session');

      await fs.writeFile(path.join(testDir, 'file2.ts'), 'content2', 'utf-8');
      await checkpointStore.createCheckpoint('create_file', ['file2.ts']);

      const checkpoints = checkpointStore.listCheckpoints();
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].sessionId).toBe('new-session');
    });
  });
});

describe('CheckpointStore repo-trust hardening', () => {
  async function makeBareDir(): Promise<string> {
    const dir = path.join(tmpdir(), `b4m-ckpt-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  it('refuses a symlinked shadow-repo and runs no git in the link target', async () => {
    const proj = await makeBareDir();
    const outside = await makeBareDir(); // stands in for wherever the link points
    try {
      await fs.mkdir(path.join(proj, '.b4m'), { recursive: true });
      await fs.symlink(outside, path.join(proj, '.b4m', 'shadow-repo'));

      const store = new CheckpointStore(proj);
      await expect(store.init('sess')).rejects.toThrow(/symlink/i);

      // No shadow git repo was initialized through the link.
      expect(existsSync(path.join(outside, '.git'))).toBe(false);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('does not execute a planted git hook when committing a checkpoint', async () => {
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      const canary = path.join(proj, 'HOOK_RAN');
      const hooksDir = path.join(proj, '.b4m', 'shadow-repo', '.git', 'hooks');
      await fs.writeFile(path.join(hooksDir, 'pre-commit'), `#!/bin/sh\ntouch "${canary}"\n`, { mode: 0o755 });

      await fs.writeFile(path.join(proj, 'f.ts'), 'x', 'utf-8');
      await store.createCheckpoint('create_file', ['f.ts']);

      // core.hooksPath=/dev/null means the planted hook never fires.
      expect(existsSync(canary)).toBe(false);
    } finally {
      await cleanup(proj);
    }
  });

  it('refuses to write through a symlink committed inside shadow-repo/', async () => {
    const proj = await createTestProject();
    const outside = await makeBareDir();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      // Attacker committed .b4m/shadow-repo/payload.ts as a symlink to a victim file.
      const victim = path.join(outside, 'victim.txt');
      await fs.writeFile(victim, 'victim-original', 'utf-8');
      await fs.symlink(victim, path.join(proj, '.b4m', 'shadow-repo', 'payload.ts'));

      await fs.writeFile(path.join(proj, 'payload.ts'), 'ATTACKER-CONTROLLED', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['payload.ts']);

      // The write is refused; nothing outside the shadow repo is touched.
      expect(cp).toBeNull();
      expect(await fs.readFile(victim, 'utf-8')).toBe('victim-original');
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('refuses a gitlink (file/symlink `.git`) planted at shadow-repo', async () => {
    const proj = await makeBareDir();
    try {
      await fs.mkdir(path.join(proj, '.b4m', 'shadow-repo'), { recursive: true });
      // A gitlink is a `.git` FILE, not a directory; it survives clone and would
      // point git at an attacker-controlled gitdir.
      await fs.writeFile(path.join(proj, '.b4m', 'shadow-repo', '.git'), 'gitdir: /tmp/evil\n', 'utf-8');

      const store = new CheckpointStore(proj);
      await expect(store.init('sess')).rejects.toThrow(/not a real git directory/i);
    } finally {
      await cleanup(proj);
    }
  });

  it('ignores hostile GIT_DIR / GIT_WORK_TREE / GIT_CONFIG_* in the ambient env when checkpointing', async () => {
    const proj = await createTestProject();
    const bogus = await makeBareDir(); // empty dir - not a git repo
    const saved = {
      dir: process.env.GIT_DIR,
      wt: process.env.GIT_WORK_TREE,
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      val: process.env.GIT_CONFIG_VALUE_0,
    };
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      // If any of these leaked into the shadow git calls the checkpoint would fail:
      // GIT_DIR/GIT_WORK_TREE redirect the repo to an empty non-repo, and the
      // GIT_CONFIG_* injection sets `core.bare=true` (a bare repo cannot commit a
      // worktree). All are neutralized, so the checkpoint succeeds and restores.
      process.env.GIT_DIR = bogus;
      process.env.GIT_WORK_TREE = bogus;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.bare';
      process.env.GIT_CONFIG_VALUE_0 = 'true';

      await fs.writeFile(path.join(proj, 'f.ts'), 'original', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['f.ts']);
      expect(cp).not.toBeNull();

      // Negative control: git ran in the shadow repo, not the ambient GIT_DIR.
      expect(existsSync(path.join(bogus, 'HEAD'))).toBe(false);
      expect(existsSync(path.join(bogus, 'objects'))).toBe(false);

      // Positive control: the shadow repo is a real repo that can restore.
      await fs.writeFile(path.join(proj, 'f.ts'), 'modified', 'utf-8');
      await store.restoreCheckpoint(1);
      expect(await fs.readFile(path.join(proj, 'f.ts'), 'utf-8')).toBe('original');
    } finally {
      const restore = (k: string, v: string | undefined) =>
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      restore('GIT_DIR', saved.dir);
      restore('GIT_WORK_TREE', saved.wt);
      restore('GIT_CONFIG_COUNT', saved.count);
      restore('GIT_CONFIG_KEY_0', saved.key);
      restore('GIT_CONFIG_VALUE_0', saved.val);
      await cleanup(proj);
      await cleanup(bogus);
    }
  });

  it('refuses to write through a symlinked .gitignore at init, leaving the victim untouched', async () => {
    // Blocking: init() -> ensureGitignore rewrites .gitignore at startup with no
    // user action; a committed symlink would corrupt a file outside the checkout.
    const proj = await makeBareDir();
    const outside = await makeBareDir();
    try {
      const victim = path.join(outside, 'victim.txt');
      await fs.writeFile(victim, 'IMPORTANT-USER-FILE', 'utf-8');
      await fs.symlink(victim, path.join(proj, '.gitignore'));

      const store = new CheckpointStore(proj);
      // init must not throw (gitignore update is non-critical) but must not follow the link.
      await store.init('sess');

      expect(await fs.readFile(victim, 'utf-8')).toBe('IMPORTANT-USER-FILE');
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('refuses to write diff temp files through a committed .diff-a symlink', async () => {
    const proj = await createTestProject();
    const outside = await makeBareDir();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      await fs.writeFile(path.join(proj, 'f.ts'), 'v1\n', 'utf-8');
      await store.createCheckpoint('edit_local_file', ['f.ts']);
      await fs.writeFile(path.join(proj, 'f.ts'), 'v2\n', 'utf-8');

      const victim = path.join(outside, 'victim.txt');
      await fs.writeFile(victim, 'victim-original', 'utf-8');
      await fs.symlink(victim, path.join(proj, '.b4m', 'shadow-repo', '.diff-a'));

      expect(() => store.getCheckpointDiff(1)).toThrow(/symlink|sandbox/i);
      expect(await fs.readFile(victim, 'utf-8')).toBe('victim-original');
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('refuses to restore through a worktree directory swapped for a symlink', async () => {
    const proj = await createTestProject();
    const outside = await makeBareDir();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      await fs.mkdir(path.join(proj, 'sub'), { recursive: true });
      await fs.writeFile(path.join(proj, 'sub', 'app.ts'), 'original', 'utf-8');
      await store.createCheckpoint('edit_local_file', ['sub/app.ts']);

      // Attacker swaps sub/ for a symlink to outside (a committed checkpoints.json
      // makes checkpoint.filePaths attacker-influenceable in the wild).
      await fs.rm(path.join(proj, 'sub'), { recursive: true, force: true });
      await fs.symlink(outside, path.join(proj, 'sub'));

      await expect(store.restoreCheckpoint(1)).rejects.toThrow(/sandbox|symlink|traversal/i);
      expect(existsSync(path.join(outside, 'app.ts'))).toBe(false);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('does not mkdir into the link target for a symlinked intermediate shadow dir', async () => {
    const proj = await createTestProject();
    const outside = await makeBareDir();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      // A committed .b4m/shadow-repo/evil symlink to outside would have `mkdir -p`
      // create `evil/deep` in the link target before any leaf guard fired.
      await fs.symlink(outside, path.join(proj, '.b4m', 'shadow-repo', 'evil'));

      await fs.mkdir(path.join(proj, 'evil', 'deep'), { recursive: true });
      await fs.writeFile(path.join(proj, 'evil', 'deep', 'f.ts'), 'x', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['evil/deep/f.ts']);

      expect(cp).toBeNull();
      expect(existsSync(path.join(outside, 'deep'))).toBe(false);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('refuses shadow writes after shadow-repo is swapped for a symlink post-init', async () => {
    // The containment root is anchored at init(), so a later swap of shadow-repo
    // to a symlink is detected instead of resolving both sides through the link.
    const proj = await createTestProject();
    const outside = await makeBareDir();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      const shadow = path.join(proj, '.b4m', 'shadow-repo');
      await fs.rm(shadow, { recursive: true, force: true });
      await fs.symlink(outside, shadow);

      await fs.writeFile(path.join(proj, 'f.ts'), 'x', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['f.ts']);

      expect(cp).toBeNull();
      expect(existsSync(path.join(outside, 'f.ts'))).toBe(false);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('does not honor a $HOME/.gitconfig core.hooksPath when committing a checkpoint', async () => {
    // Distinct from the shadow-repo .git/hooks vector: a hostile clone can also
    // ship a global config that redirects hooksPath. git() forces
    // GIT_CONFIG_GLOBAL=/dev/null, so an ambient ~/.gitconfig never applies.
    const proj = await createTestProject();
    const home = await makeBareDir();
    const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      const canary = path.join(proj, 'GLOBAL_HOOK_RAN');
      const hooksDir = path.join(home, 'evil-hooks');
      await fs.mkdir(hooksDir, { recursive: true });
      await fs.writeFile(path.join(hooksDir, 'pre-commit'), `#!/bin/sh\ntouch "${canary}"\n`, { mode: 0o755 });
      await fs.writeFile(path.join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooksDir}\n`, 'utf-8');
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = home;

      await fs.writeFile(path.join(proj, 'f.ts'), 'x', 'utf-8');
      await store.createCheckpoint('create_file', ['f.ts']);

      expect(existsSync(canary)).toBe(false);
    } finally {
      const restore = (k: string, v: string | undefined) =>
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      restore('HOME', saved.home);
      restore('XDG_CONFIG_HOME', saved.xdg);
      await cleanup(proj);
      await cleanup(home);
    }
  });

  it('neutralizes a $HOME/.gitconfig commit.gpgsign via GIT_CONFIG_GLOBAL when committing', async () => {
    // The hooksPath test above stays green even if the GIT_CONFIG_GLOBAL=/dev/null
    // line is deleted, because git()'s argv `-c core.hooksPath=/dev/null` masks it
    // (higher precedence). gpgsign is NOT overridden in argv, so it isolates the
    // env override: with GIT_CONFIG_GLOBAL neutralized the commit succeeds; drop
    // that line and the ambient `gpgsign = true` makes `git commit` try to sign
    // (no key), the commit throws, and createCheckpoint returns null.
    const proj = await createTestProject();
    const home = await makeBareDir();
    const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      await fs.writeFile(path.join(home, '.gitconfig'), `[commit]\n\tgpgsign = true\n`, 'utf-8');
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = home;

      await fs.writeFile(path.join(proj, 'f.ts'), 'x', 'utf-8');
      const cp = await store.createCheckpoint('create_file', ['f.ts']);

      expect(cp).not.toBeNull();
    } finally {
      const restore = (k: string, v: string | undefined) =>
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      restore('HOME', saved.home);
      restore('XDG_CONFIG_HOME', saved.xdg);
      await cleanup(proj);
      await cleanup(home);
    }
  });

  it('refuses a symlinked .b4m directory at init', async () => {
    const proj = await makeBareDir();
    const outside = await makeBareDir();
    try {
      await fs.symlink(outside, path.join(proj, '.b4m'));
      const store = new CheckpointStore(proj);
      await expect(store.init('sess')).rejects.toThrow(/symlink/i);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('refuses a symlinked .b4m/checkpoints.json at init', async () => {
    const proj = await makeBareDir();
    const outside = await makeBareDir();
    try {
      await fs.mkdir(path.join(proj, '.b4m'), { recursive: true });
      const victim = path.join(outside, 'victim.json');
      await fs.writeFile(victim, '{"checkpoints":[]}', 'utf-8');
      await fs.symlink(victim, path.join(proj, '.b4m', 'checkpoints.json'));

      const store = new CheckpointStore(proj);
      await expect(store.init('sess')).rejects.toThrow(/symlink/i);
    } finally {
      await cleanup(proj);
      await cleanup(outside);
    }
  });

  it('drops a null/non-object entry in checkpoints.json without discarding valid entries', async () => {
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['f.ts']);
      expect(cp).not.toBeNull();

      // A hostile clone commits a null alongside the valid entry. Reading cp.id
      // (not cp?.id) throws and the catch resets the whole history to empty.
      const metaPath = path.join(proj, '.b4m', 'checkpoints.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.checkpoints = [null, ...meta.checkpoints];
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      expect(reopened.listCheckpoints()).toHaveLength(1);
    } finally {
      await cleanup(proj);
    }
  });

  it('does not lose subsequent checkpoints when checkpoints.json has a non-object (array) root', async () => {
    // A hostile clone commits `[]` as the root. Before the container guard,
    // this.metadata became that array; saveMetadata re-serialized `[]`, so every
    // checkpoint created afterward was silently lost on restart (a loud failure
    // turned silent). The guard coerces a bad root to a valid empty container.
    const proj = await createTestProject();
    try {
      await fs.mkdir(path.join(proj, '.b4m'), { recursive: true });
      await fs.writeFile(path.join(proj, '.b4m', 'checkpoints.json'), '[]', 'utf-8');

      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['f.ts']);
      expect(cp).not.toBeNull();

      // Restart: the checkpoint created above must still be there.
      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      expect(reopened.listCheckpoints()).toHaveLength(1);
    } finally {
      await cleanup(proj);
    }
  });

  it('drops a committed entry whose filePaths is not an array (would throw on restore/list)', async () => {
    // A sha-like id passes the id gate, but a non-array filePaths makes
    // restoreCheckpoint/getCheckpointDiff throw `filePaths is not iterable` and
    // /checkpoints read `.length` of a non-array. Drop it at parse time instead.
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      const cp = await store.createCheckpoint('edit_local_file', ['f.ts']);
      expect(cp).not.toBeNull();

      const metaPath = path.join(proj, '.b4m', 'checkpoints.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.checkpoints[0].filePaths = null; // id stays valid; sessionId still matches
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      // Dropped at load, so no sink ever iterates a non-array filePaths.
      expect(reopened.listCheckpoints()).toHaveLength(0);
      await expect(reopened.restoreCheckpoint(1)).rejects.toThrow(/not found/);
    } finally {
      await cleanup(proj);
    }
  });

  it('drops a committed entry whose filePaths holds a non-string element (partial-restore guard)', async () => {
    // A sha-like id and an array filePaths pass the coarse checks, but a null
    // element would restore the first file, then throw in validatePathWithinProject
    // mid-loop - a partial restore from a half-typed entry. The per-element string
    // check drops it at parse. Removing that check (the reviewer's mutation) leaves
    // the entry, so listCheckpoints returns it -> this fails.
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      expect(await store.createCheckpoint('edit_local_file', ['f.ts'])).not.toBeNull();

      const metaPath = path.join(proj, '.b4m', 'checkpoints.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.checkpoints[0].filePaths = ['f.ts', null];
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      expect(reopened.listCheckpoints()).toHaveLength(0);
    } finally {
      await cleanup(proj);
    }
  });

  it.each(['name', 'timestamp'] as const)('drops a committed entry whose %s is not a string', async field => {
    // Deleting the `typeof cp.%s === 'string'` guard leaves the tampered entry
    // in the set (listCheckpoints does not filter on this field), so it appears
    // -> this fails. (sessionId is additionally backstopped by listCheckpoints'
    // string-equality filter, so it is covered separately below.)
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      expect(await store.createCheckpoint('edit_local_file', ['f.ts'])).not.toBeNull();

      const metaPath = path.join(proj, '.b4m', 'checkpoints.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.checkpoints[0][field] = 42; // non-string
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      expect(reopened.listCheckpoints()).toHaveLength(0);
    } finally {
      await cleanup(proj);
    }
  });

  it('drops a committed entry whose sessionId is not a string', async () => {
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');
      await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
      expect(await store.createCheckpoint('edit_local_file', ['f.ts'])).not.toBeNull();

      const metaPath = path.join(proj, '.b4m', 'checkpoints.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.checkpoints[0].sessionId = 42;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      const reopened = new CheckpointStore(proj);
      await reopened.init('sess');
      expect(reopened.listCheckpoints()).toHaveLength(0);
    } finally {
      await cleanup(proj);
    }
  });

  it.each(['null', '42', '"x"'])(
    'does not lose subsequent checkpoints when checkpoints.json root is the non-object %s',
    async root => {
      // The array-root case (`[]`) is covered above; a hostile clone can commit any
      // non-object root. The container guard coerces each to a valid empty container
      // so a checkpoint created afterward survives a restart instead of being lost.
      const proj = await createTestProject();
      try {
        await fs.mkdir(path.join(proj, '.b4m'), { recursive: true });
        await fs.writeFile(path.join(proj, '.b4m', 'checkpoints.json'), root, 'utf-8');

        const store = new CheckpointStore(proj);
        await store.init('sess');
        await fs.writeFile(path.join(proj, 'f.ts'), 'v1', 'utf-8');
        expect(await store.createCheckpoint('edit_local_file', ['f.ts'])).not.toBeNull();

        const reopened = new CheckpointStore(proj);
        await reopened.init('sess');
        expect(reopened.listCheckpoints()).toHaveLength(1);
      } finally {
        await cleanup(proj);
      }
    }
  );

  it('refuses a write whose ancestor is a dangling symlink', async () => {
    // A live symlink ancestor is caught because realpath resolves it outside the
    // root. A DANGLING one is the gap: existsSync follows and reports false, so an
    // existsSync-based walk would skip it and rebuild a path lexically under root.
    const proj = await createTestProject();
    try {
      const store = new CheckpointStore(proj);
      await store.init('sess');

      await fs.symlink(path.join(proj, 'nonexistent-target'), path.join(proj, 'sub'));

      // filePaths is attacker-influenceable via a committed checkpoints.json.
      const cp = await store.createCheckpoint('edit_local_file', ['sub/app.ts']);
      expect(cp).toBeNull();
    } finally {
      await cleanup(proj);
    }
  });
});

describe('checkpoint id validation (git option-injection)', () => {
  let dir: string;
  let store: CheckpointStore;

  beforeEach(async () => {
    dir = await createTestProject();
    store = new CheckpointStore(dir);
    await store.init(sessionId);
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('refuses a tampered checkpoint id and writes nothing outside the checkout', async () => {
    const rel = 'file.txt';
    await fs.writeFile(path.join(dir, rel), 'v1', 'utf-8');
    const cp = await store.createCheckpoint('edit_local_file', [rel]);
    expect(cp).not.toBeNull();

    // A hostile clone can commit `.b4m/checkpoints.json`. Tamper the id into a
    // `git show --output=` option that would write a file outside the checkout.
    const evilDir = path.join(tmpdir(), `b4m-evil-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(evilDir, { recursive: true });
    const metaPath = path.join(dir, '.b4m', 'checkpoints.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    meta.checkpoints[0].id = `--output=${path.join(evilDir, 'pwned')}`;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // Reload: the tampered entry is dropped at parse time, so no sink ever sees it.
    const reopened = new CheckpointStore(dir);
    await reopened.init(sessionId);

    await expect(reopened.restoreCheckpoint(1)).rejects.toThrow(/not found/);
    expect(await fs.readdir(evilDir)).toEqual([]);

    await cleanup(evilDir);
  });
});
