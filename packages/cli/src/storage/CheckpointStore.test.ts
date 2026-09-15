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
