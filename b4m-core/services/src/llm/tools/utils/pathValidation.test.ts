import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isPathAllowed, assertPathAllowed } from './pathValidation';
import { mkdtemp, writeFile, rm, symlink, mkdir, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('pathValidation', () => {
  let testDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    // Resolve symlinks in testDir (macOS: /var -> /private/var)
    testDir = await realpath(await mkdtemp(join(tmpdir(), 'path-validation-test-')));
    process.chdir(testDir);

    // Create test directory structure
    await mkdir(join(testDir, 'subdir'));
    await mkdir(join(testDir, 'subdir', 'nested'));
    await writeFile(join(testDir, 'file.txt'), 'hello');
    await writeFile(join(testDir, 'subdir', 'file.txt'), 'hello');

    // Create an outside directory for testing allowed dirs
    await mkdir(join(testDir, '..', 'outside-dir-test'), { recursive: true });
    await writeFile(join(testDir, '..', 'outside-dir-test', 'secret.txt'), 'secret');
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
    await rm(join(testDir, '..', 'outside-dir-test'), { recursive: true, force: true }).catch(() => {});
  });

  describe('isPathAllowed', () => {
    it('should allow files within cwd', () => {
      const result = isPathAllowed('file.txt');
      expect(result.allowed).toBe(true);
    });

    it('should allow files in subdirectories', () => {
      const result = isPathAllowed('subdir/file.txt');
      expect(result.allowed).toBe(true);
    });

    it('should allow nested subdirectories', () => {
      const result = isPathAllowed('subdir/nested');
      expect(result.allowed).toBe(true);
    });

    it('should allow absolute paths within cwd', () => {
      const result = isPathAllowed(join(testDir, 'file.txt'));
      expect(result.allowed).toBe(true);
    });

    it('should deny paths outside cwd', () => {
      const result = isPathAllowed('/etc/passwd');
      expect(result.allowed).toBe(false);
    });

    it('should deny path traversal attempts', () => {
      const result = isPathAllowed('../../../etc/passwd');
      expect(result.allowed).toBe(false);
    });

    it('should deny path traversal via subdir/../../..', () => {
      const result = isPathAllowed('subdir/../../../etc/passwd');
      expect(result.allowed).toBe(false);
    });

    it('should allow path with ../ that stays within cwd', () => {
      const result = isPathAllowed('subdir/../file.txt');
      expect(result.allowed).toBe(true);
    });

    it('should return the resolved absolute path', () => {
      const result = isPathAllowed('subdir/file.txt');
      expect(result.resolvedPath).toBe(join(testDir, 'subdir', 'file.txt'));
    });

    it('should return the matched directory', () => {
      const result = isPathAllowed('file.txt');
      expect(result.allowed).toBe(true);
      expect(result.matchedDirectory).toBeTruthy();
    });

    it('should allow the cwd itself', () => {
      const result = isPathAllowed(testDir);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isPathAllowed with additional directories', () => {
    it('should allow paths in additional directories', () => {
      const outsideDir = join(testDir, '..', 'outside-dir-test');
      const result = isPathAllowed(join(outsideDir, 'secret.txt'), [outsideDir]);
      expect(result.allowed).toBe(true);
    });

    it('should still deny paths not in any allowed directory', () => {
      const outsideDir = join(testDir, '..', 'outside-dir-test');
      const result = isPathAllowed('/etc/passwd', [outsideDir]);
      expect(result.allowed).toBe(false);
    });

    it('should still allow cwd paths when additional dirs are set', () => {
      const outsideDir = join(testDir, '..', 'outside-dir-test');
      const result = isPathAllowed('file.txt', [outsideDir]);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isPathAllowed with symlinks', () => {
    let symlinkDir: string;
    let targetDir: string;

    beforeAll(async () => {
      // Create a target directory outside cwd
      targetDir = join(testDir, '..', 'symlink-target-test');
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'secret.txt'), 'secret');

      // Create a symlink inside cwd pointing outside
      symlinkDir = join(testDir, 'sneaky-link');
      await symlink(targetDir, symlinkDir);
    });

    afterAll(async () => {
      await rm(symlinkDir, { force: true });
      await rm(targetDir, { recursive: true, force: true });
    });

    it('should deny access through symlinks that escape cwd', () => {
      const result = isPathAllowed('sneaky-link/secret.txt');
      expect(result.allowed).toBe(false);
    });

    it('should deny the symlink directory itself when target is outside cwd', () => {
      const result = isPathAllowed('sneaky-link');
      expect(result.allowed).toBe(false);
    });

    it('should allow symlink access when target is in allowed directories', () => {
      const result = isPathAllowed('sneaky-link/secret.txt', [targetDir]);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isPathAllowed with non-existent paths', () => {
    it('should allow non-existent files within cwd', () => {
      const result = isPathAllowed('does-not-exist.txt');
      expect(result.allowed).toBe(true);
    });

    it('should allow non-existent nested paths within cwd', () => {
      const result = isPathAllowed('subdir/new-file.txt');
      expect(result.allowed).toBe(true);
    });

    it('should deny non-existent paths outside cwd', () => {
      const result = isPathAllowed('/tmp/does-not-exist/file.txt');
      expect(result.allowed).toBe(false);
    });
  });

  describe('assertPathAllowed', () => {
    it('should return resolved path for allowed paths', () => {
      const result = assertPathAllowed('file.txt');
      expect(result).toBe(join(testDir, 'file.txt'));
    });

    it('should throw for disallowed paths', () => {
      expect(() => assertPathAllowed('/etc/passwd')).toThrow('Access denied');
    });

    it('should include operation in error message', () => {
      expect(() => assertPathAllowed('/etc/passwd', undefined, 'read')).toThrow('Cannot read files');
    });

    it('should throw for path traversal', () => {
      expect(() => assertPathAllowed('../../../etc/passwd')).toThrow('Access denied');
    });

    it('should list allowed directories in error message', () => {
      const extraDir = '/tmp/allowed';
      expect(() => assertPathAllowed('/etc/passwd', [extraDir])).toThrow(extraDir);
    });
  });

  describe('edge cases', () => {
    it('should handle trailing slashes via path normalization', () => {
      const result1 = isPathAllowed('subdir/');
      const result2 = isPathAllowed('subdir');
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      // Both should resolve to the same path
      expect(result1.resolvedPath).toBe(result2.resolvedPath);
    });

    it('should handle dot paths', () => {
      const result = isPathAllowed('./file.txt');
      expect(result.allowed).toBe(true);
    });

    it('should handle double dots that stay within cwd', () => {
      const result = isPathAllowed('subdir/nested/../../file.txt');
      expect(result.allowed).toBe(true);
    });
  });
});
