import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileReadTool } from './index';
import { mkdtemp, writeFile, rm } from 'fs/promises';
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
});
