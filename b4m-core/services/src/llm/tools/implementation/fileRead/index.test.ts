import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileReadTool } from './index';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('fileReadTool', () => {
  let testDir: string;
  let testFilePath: string;
  let originalCwd: string;

  const mockLogger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };

  const mockContext = {
    logger: mockLogger,
  };

  beforeAll(async () => {
    // Save original cwd
    originalCwd = process.cwd();

    // Create a temporary directory for test files
    testDir = await mkdtemp(join(tmpdir(), 'file-read-test-'));
    process.chdir(testDir);

    // Create a test file with 10 lines
    testFilePath = join(testDir, 'test.txt');
    const content = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
    await writeFile(testFilePath, content);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it('should read entire file without offset or limit', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt' });

    expect(result).toContain('Line 1');
    expect(result).toContain('Line 10');
    expect(result).not.toContain('Showing lines');
  });

  it('should read file with offset only', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt', offset: 5 });

    expect(result).toContain('Line 6'); // 0-based offset 5 = line 6
    expect(result).toContain('Line 10');
    expect(result).not.toMatch(/^Line 1$/m); // Line 1 as a complete line should not be present
    expect(result).not.toContain('Line 2');
    expect(result).toContain('Showing lines 6-10');
  });

  it('should read file with offset and limit', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt', offset: 2, limit: 3 });

    expect(result).toContain('Line 3'); // offset 2 = line 3
    expect(result).toContain('Line 4');
    expect(result).toContain('Line 5');
    expect(result).not.toMatch(/^Line 1$/m); // Line 1 as a complete line should not be present
    expect(result).not.toMatch(/^Line 2$/m); // Line 2 as a complete line should not be present
    expect(result).not.toMatch(/^Line 6$/m); // Line 6 as a complete line should not be present
    expect(result).toContain('Showing lines 3-5');
    expect(result).toContain('To read more, use offset: 5');
  });

  it('should handle offset at end of file', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt', offset: 10 });

    expect(result).toContain('No content to show');
    expect(result).toContain('File has 10 lines, but offset is 10');
  });

  it('should handle limit reaching end of file', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt', offset: 8, limit: 10 });

    expect(result).toContain('Line 9');
    expect(result).toContain('Line 10');
    expect(result).toContain('End of file reached');
    expect(result).not.toContain('To read more');
  });

  it('should handle negative offset', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'test.txt', offset: -1 });

    expect(result).toContain('Error reading file');
    expect(result).toContain('Invalid offset: -1');
  });

  it('should handle non-existent file', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: 'nonexistent.txt' });

    expect(result).toContain('Error reading file');
    expect(result).toContain('File not found');
  });

  it('should prevent path traversal', async () => {
    const tool = fileReadTool.implementation(mockContext as never, {});
    const result = await tool.toolFn({ path: '../../../etc/passwd' });

    expect(result).toContain('Error reading file');
    expect(result).toContain('Access denied');
  });

  describe('minified mode', () => {
    // Fake stand-in for the CLI's tree-sitter stripper: removes JS line comments.
    const fakeMinifier = async (source: string) => source.replace(/^\s*\/\/.*$/gm, '');
    const minifyContext = { logger: mockLogger, codeMinifier: fakeMinifier };

    let bigFile: string;
    let bigRaw: string;

    beforeAll(async () => {
      // Comment-heavy file comfortably above the small-file fast-path threshold (1KB).
      const block = Array.from(
        { length: 40 },
        (_, i) => `// explanatory comment number ${i}\nconst v${i} = ${i};`
      ).join('\n');
      bigRaw = `${block}\n`;
      bigFile = join(testDir, 'big.ts');
      await writeFile(bigFile, bigRaw);
    });

    it('strips comments, reports savings, and adds a steer-to-file_read header', async () => {
      const tool = fileReadTool.implementation(minifyContext as never, {});
      const result = await tool.toolFn({ path: 'big.ts', minified: true });

      expect(result).toContain('[Minified view of big.ts');
      expect(result).toContain('tokens saved');
      expect(result).toContain('Use file_read WITHOUT minified');
      expect(result).not.toContain('explanatory comment');
      expect(result).toContain('const v0 = 0;');
      expect(result).toContain('const v39 = 39;');
    });

    it('never mutates the file on disk', async () => {
      const tool = fileReadTool.implementation(minifyContext as never, {});
      await tool.toolFn({ path: 'big.ts', minified: true });

      const onDisk = await readFile(bigFile, 'utf-8');
      expect(onDisk).toBe(bigRaw); // raw bytes preserved -> edit staleness detection intact
    });

    it('falls back to whitespace-only normalization when no minifier is injected', async () => {
      const tool = fileReadTool.implementation(mockContext as never, {});
      const result = await tool.toolFn({ path: 'big.ts', minified: true });

      expect(result).toContain('[Minified view of big.ts');
      expect(result).toContain('comments kept');
      expect(result).toContain('explanatory comment'); // comments preserved on fallback
    });

    it('skips minification for small files (fast path returns raw content)', async () => {
      const tool = fileReadTool.implementation(minifyContext as never, {});
      const result = await tool.toolFn({ path: 'test.txt', minified: true });

      expect(result).not.toContain('[Minified view');
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 10');
    });
  });
});
