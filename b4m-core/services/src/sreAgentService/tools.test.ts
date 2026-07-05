import { describe, it, expect, vi } from 'vitest';
import { executeTool } from './tools';
import type { SreToolContext } from './tools';
import { RATE_LIMITED_SENTINEL } from './tools';

function makeCtx(content: string | null = null): SreToolContext {
  return {
    getFileContent: vi.fn().mockResolvedValue(content),
    searchCode: vi.fn(),
    listFiles: vi.fn(),
    apiCallCounter: { count: 0, max: 100 },
  };
}

describe('apiCallCounter budget', () => {
  it('increments count on each successful tool call', async () => {
    const ctx = makeCtx('alpha\nbeta');
    expect(ctx.apiCallCounter.count).toBe(0);
    await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 1, end_line: 1 }, ctx);
    expect(ctx.apiCallCounter.count).toBe(1);
    await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 2, end_line: 2 }, ctx);
    expect(ctx.apiCallCounter.count).toBe(2);
  });

  it('returns budget-exhausted sentinel when count >= max', async () => {
    const ctx = makeCtx('alpha');
    ctx.apiCallCounter.count = ctx.apiCallCounter.max; // saturate budget
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 1, end_line: 1 }, ctx);
    expect(result).toBe(
      'Tool execution unavailable. Please complete your analysis with the information gathered so far.'
    );
    // count must not increment when budget is exhausted
    expect(ctx.apiCallCounter.count).toBe(ctx.apiCallCounter.max);
  });

  it('does not count rate-limited github_search_code against budget', async () => {
    const ctx: SreToolContext = {
      getFileContent: vi.fn(),
      searchCode: vi.fn().mockResolvedValue(`${RATE_LIMITED_SENTINEL} (10 req/min)`),
      listFiles: vi.fn(),
      apiCallCounter: { count: 0, max: 100 },
    };
    await executeTool('github_code_search', { query: 'foo' }, ctx);
    // Rate-limited: pre-increment rolled back, net 0
    expect(ctx.apiCallCounter.count).toBe(0);
  });
});

describe('github_file_read', () => {
  it('returns file content', async () => {
    const ctx = makeCtx('hello world');
    const result = await executeTool('github_file_read', { path: 'f.ts' }, ctx);
    expect(result).toBe('hello world');
    expect(ctx.apiCallCounter.count).toBe(1);
  });

  it('returns file-not-found with sibling listing when parent dir has files', async () => {
    const ctx: SreToolContext = {
      getFileContent: vi.fn().mockResolvedValue(null),
      searchCode: vi.fn(),
      listFiles: vi.fn().mockResolvedValue(['sibling.ts', 'other.ts']),
      apiCallCounter: { count: 0, max: 100 },
    };
    const result = await executeTool('github_file_read', { path: 'src/missing.ts' }, ctx);
    expect(result).toMatch(/File not found: src\/missing\.ts/);
    expect(result).toMatch(/sibling\.ts/);
    // listFiles is a direct ctx call, does NOT increment apiCallCounter
    expect(ctx.apiCallCounter.count).toBe(1);
  });

  it('returns plain file-not-found when no path separator (top-level file)', async () => {
    const ctx: SreToolContext = {
      getFileContent: vi.fn().mockResolvedValue(null),
      searchCode: vi.fn(),
      listFiles: vi.fn(),
      apiCallCounter: { count: 0, max: 100 },
    };
    const result = await executeTool('github_file_read', { path: 'missing.ts' }, ctx);
    expect(result).toBe('File not found: missing.ts');
    expect(ctx.listFiles).not.toHaveBeenCalled();
  });

  it('returns error when path is missing', async () => {
    const ctx = makeCtx('content');
    const result = await executeTool('github_file_read', {}, ctx);
    expect(result).toBe('Error: path parameter is required');
  });

  it('truncates output at 10000 chars', async () => {
    const longContent = 'x'.repeat(15000);
    const ctx = makeCtx(longContent);
    const result = await executeTool('github_file_read', { path: 'big.ts' }, ctx);
    expect(result).toMatch(/\[truncated at 10000 chars\]/);
    expect(result.length).toBeLessThan(11000);
  });
});

describe('github_list_files', () => {
  it('returns newline-joined file list', async () => {
    const ctx: SreToolContext = {
      getFileContent: vi.fn(),
      searchCode: vi.fn(),
      listFiles: vi.fn().mockResolvedValue(['a.ts', 'b.ts', 'c.ts']),
      apiCallCounter: { count: 0, max: 100 },
    };
    const result = await executeTool('github_list_files', { path: 'src/' }, ctx);
    expect(result).toBe('a.ts\nb.ts\nc.ts');
    expect(ctx.apiCallCounter.count).toBe(1);
  });

  it('returns no-files message for empty directory', async () => {
    const ctx: SreToolContext = {
      getFileContent: vi.fn(),
      searchCode: vi.fn(),
      listFiles: vi.fn().mockResolvedValue([]),
      apiCallCounter: { count: 0, max: 100 },
    };
    const result = await executeTool('github_list_files', { path: 'empty/' }, ctx);
    expect(result).toBe('No files found at: empty/');
  });

  it('returns error when path is missing', async () => {
    const ctx = makeCtx();
    const result = await executeTool('github_list_files', {}, ctx);
    expect(result).toBe('Error: path parameter is required');
  });
});

describe('github_file_read_lines', () => {
  it('returns numbered lines for a valid range', async () => {
    const ctx = makeCtx('alpha\nbeta\ngamma\ndelta\nepsilon');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 2, end_line: 4 }, ctx);
    expect(result).toBe('2: beta\n3: gamma\n4: delta');
  });

  it('returns single line when start_line === end_line', async () => {
    const ctx = makeCtx('alpha\nbeta\ngamma');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 2, end_line: 2 }, ctx);
    expect(result).toBe('2: beta');
  });

  it('clamps inverted range (end_line < start_line) to single line', async () => {
    const ctx = makeCtx('alpha\nbeta\ngamma');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 3, end_line: 1 }, ctx);
    expect(result).toBe('3: gamma');
  });

  it('clamps range that exceeds MAX_LINE_RANGE (200 lines)', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line${i + 1}`);
    const ctx = makeCtx(lines.join('\n'));
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 1, end_line: 300 }, ctx);
    const resultLines = result.split('\n');
    expect(resultLines).toHaveLength(200);
    expect(resultLines[0]).toBe('1: line1');
    expect(resultLines[199]).toBe('200: line200');
  });

  it('clamps start_line < 1 to 1', async () => {
    const ctx = makeCtx('alpha\nbeta\ngamma');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: -5, end_line: 2 }, ctx);
    expect(result).toMatch(/^1: alpha/);
  });

  it('returns file-not-found when content is null', async () => {
    const ctx = makeCtx(null);
    const result = await executeTool('github_file_read_lines', { path: 'missing.ts', start_line: 1, end_line: 5 }, ctx);
    expect(result).toBe('File not found: missing.ts');
  });

  it('returns error when path is missing', async () => {
    const ctx = makeCtx('content');
    const result = await executeTool('github_file_read_lines', { start_line: 1, end_line: 2 }, ctx);
    expect(result).toBe('Error: path parameter is required');
  });

  it('defaults missing start_line to 1', async () => {
    const ctx = makeCtx('alpha\nbeta');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', end_line: 2 }, ctx);
    expect(result).toMatch(/^1: alpha/);
  });

  it('defaults missing end_line to start_line (single-line read)', async () => {
    const ctx = makeCtx('alpha\nbeta\ngamma');
    const result = await executeTool('github_file_read_lines', { path: 'f.ts', start_line: 2 }, ctx);
    expect(result).toBe('2: beta');
  });
});
