import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { grepSearchTool } from './index';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('grepSearch', () => {
  let testDir: string;
  let originalCwd: string;

  // Mock logger for tool context
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
    originalCwd = process.cwd();

    testDir = await mkdtemp(join(tmpdir(), 'grep-test-'));

    // Create test file structure
    await writeFile(
      join(testDir, 'test1.ts'),
      `import { Component } from 'react';
export function myFunction() {
  console.log('Hello World');
  return true;
}

class TestClass {
  method() {
    // Another function here
  }
}`
    );

    await writeFile(
      join(testDir, 'test2.js'),
      `function anotherFunction() {
  const value = 42;
  return value;
}

// This is a comment
export default anotherFunction;`
    );

    await writeFile(
      join(testDir, 'README.md'),
      `# Test Project
This is a test project with function examples.
We have multiple functions defined.`
    );

    await mkdir(join(testDir, 'src'));
    await writeFile(
      join(testDir, 'src', 'index.tsx'),
      `import React from 'react';

export const MyComponent = () => {
  return <div>Hello</div>;
};`
    );

    await mkdir(join(testDir, 'src', 'components'));
    await writeFile(
      join(testDir, 'src', 'components', 'Button.tsx'),
      `import React from 'react';

export const Button = ({ onClick }) => {
  return <button onClick={onClick}>Click me</button>;
};`
    );

    // Create a large file (simulate content over 200 chars per line)
    const longLine = 'a'.repeat(250);
    await writeFile(join(testDir, 'large.txt'), `${longLine}\nNormal line\n${longLine}`);

    process.chdir(testDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  describe('basic search functionality', () => {
    it('should find matches for a simple pattern', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function' });

      expect(result).toContain('Found');
      expect(result).toContain('test1.ts');
      expect(result).toContain('test2.js');
      expect(result).toContain('myFunction');
      expect(result).toContain('anotherFunction');
    });

    it('should be case-insensitive by default', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'FUNCTION' });

      expect(result).toContain('Found');
      expect(result).toContain('function');
    });

    it('should return no matches message when pattern not found', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'nonexistentpattern12345' });

      expect(result).toContain('No matches found');
      expect(result).toContain('nonexistentpattern12345');
    });

    it('should include line numbers in results', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'console.log' });

      expect(result).toMatch(/L\d+:/);
      expect(result).toContain('console.log');
    });

    it('should truncate long lines to 200 characters', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'aaaa' });

      // The long line should be truncated with ...
      const lines = result.split('\n');
      const matchLine = lines.find(line => line.includes('...'));
      expect(matchLine).toBeDefined();
    });
  });

  describe('glob pattern filtering', () => {
    it('should filter by simple glob pattern *.ts', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function', include: '*.ts' });

      expect(result).toContain('test1.ts');
      expect(result).not.toContain('test2.js');
    });

    it('should filter by brace expansion pattern *.{ts,tsx}', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'import', include: '*.{ts,tsx}' });

      expect(result).toContain('test1.ts');
      expect(result).toContain('index.tsx');
      expect(result).toContain('Button.tsx');
      expect(result).not.toContain('test2.js');
    });

    it('should filter by directory pattern src/**', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'import', include: 'src/**' });

      expect(result).toContain('src/index.tsx');
      expect(result).toContain('src/components/Button.tsx');
      expect(result).not.toContain('test1.ts');
    });

    it('should show filter info in output', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function', include: '*.ts' });

      expect(result).toContain('filter: "*.ts"');
    });
  });

  describe('directory path handling', () => {
    it('should search in specified subdirectory', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'import', dir_path: 'src' });

      expect(result).toContain('index.tsx');
      expect(result).toContain('components/Button.tsx');
      expect(result).not.toContain('test1.ts');
    });

    it('should show directory in output', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'import', dir_path: 'src' });

      expect(result).toContain('in "src"');
    });

    it('should use relative paths in file results', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'import' });

      // Paths should be relative to search directory
      expect(result).toMatch(/File: [\w/.-]+\.tsx?/);
      expect(result).not.toContain(testDir);
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid regex pattern', async () => {
      const tool = grepSearchTool.implementation(mockContext);

      await expect(tool.toolFn({ pattern: '[invalid(' })).rejects.toThrow('Ripgrep error:');
    });

    it('should throw error for non-existent directory', async () => {
      const tool = grepSearchTool.implementation(mockContext);

      await expect(tool.toolFn({ pattern: 'test', dir_path: 'nonexistent' })).rejects.toThrow('Path does not exist');
    });

    it('should throw error for file path instead of directory', async () => {
      const tool = grepSearchTool.implementation(mockContext);

      await expect(tool.toolFn({ pattern: 'test', dir_path: 'test1.ts' })).rejects.toThrow('Path is not a directory');
    });

    it('should throw error for path outside workspace (path traversal)', async () => {
      const tool = grepSearchTool.implementation(mockContext);

      await expect(tool.toolFn({ pattern: 'test', dir_path: '../../../etc' })).rejects.toThrow(
        'Path validation failed'
      );
    });
  });

  describe('output formatting', () => {
    it('should group matches by file', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function' });

      // Each file should have a "File:" header
      const fileHeaders = result.match(/File: /g);
      expect(fileHeaders).toBeTruthy();
      expect(fileHeaders!.length).toBeGreaterThan(0);

      // Files should be separated by ---
      expect(result).toContain('---');
    });

    it('should show match count and files searched', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function' });

      expect(result).toMatch(/Found \d+ match(es)?/);
      expect(result).toMatch(/Searched \d+ file\(s\)/);
    });

    it('should use singular "match" for single result', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      // Search for "multiple functions" which appears once in README.md
      const result = await tool.toolFn({ pattern: 'multiple functions', include: '*.md' });

      // Should say "1 match" not "1 matches"
      expect(result).toContain('Found 1 match');
      expect(result).not.toContain('Found 1 matches');
    });

    it('should indicate truncation when max matches reached', async () => {
      const tool = grepSearchTool.implementation(mockContext);

      // Create many files to trigger truncation
      for (let i = 0; i < 100; i++) {
        await writeFile(join(testDir, `file${i}.txt`), 'search_term\n'.repeat(10));
      }

      const result = await tool.toolFn({ pattern: 'search_term' });

      expect(result).toContain('(truncated)');

      for (let i = 0; i < 100; i++) {
        await rm(join(testDir, `file${i}.txt`), { force: true });
      }
    });
  });

  describe('regex pattern support', () => {
    it('should support regex character classes', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function\\s+\\w+' });

      expect(result).toContain('function myFunction');
      expect(result).toContain('function anotherFunction');
    });

    it('should support word boundaries', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: '\\bimport\\b' });

      expect(result).toContain('import');
    });

    it('should support alternation', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'class|interface' });

      expect(result).toContain('class');
    });
  });

  describe('file type handling', () => {
    it('should search multiple file types', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function' });

      // Should find matches in .ts, .js files
      expect(result).toContain('.ts');
      expect(result).toContain('.js');
    });

    it('should search markdown files', async () => {
      const tool = grepSearchTool.implementation(mockContext);
      const result = await tool.toolFn({ pattern: 'function', include: '*.md' });

      expect(result).toContain('README.md');
      expect(result).toContain('functions');
    });
  });

  describe('tool schema', () => {
    it('should have correct tool name', () => {
      expect(grepSearchTool.name).toBe('grep_search');
    });

    it('should have tool schema with required fields', () => {
      const tool = grepSearchTool.implementation(mockContext);
      expect(tool.toolSchema.name).toBe('grep_search');
      expect(tool.toolSchema.description).toBeDefined();
      expect(tool.toolSchema.parameters).toBeDefined();
    });

    it('should require pattern parameter', () => {
      const tool = grepSearchTool.implementation(mockContext);
      expect(tool.toolSchema.parameters.required).toContain('pattern');
    });

    it('should have optional dir_path and include parameters', () => {
      const tool = grepSearchTool.implementation(mockContext);
      expect(tool.toolSchema.parameters.properties.dir_path).toBeDefined();
      expect(tool.toolSchema.parameters.properties.include).toBeDefined();
    });
  });
});
