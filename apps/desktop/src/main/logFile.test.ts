import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LOG_FILE_NAME,
  MAX_LOG_BYTES,
  persistConsoleWarnings,
  ROTATED_LOG_FILE_NAME,
  type LogFileSystem,
} from './logFile';

const DIRECTORY = '/logs';
const LOG = join(DIRECTORY, LOG_FILE_NAME);

function memoryFileSystem(initialSize = 0) {
  const files = new Map<string, string>();
  if (initialSize) files.set(LOG, 'x'.repeat(initialSize));
  const fs: LogFileSystem = {
    ensureDirectory: vi.fn(),
    size: path => files.get(path)?.length ?? 0,
    append: (path, contents) => files.set(path, (files.get(path) ?? '') + contents),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
  };
  return { fs, files };
}

function fakeConsole() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('persistConsoleWarnings', () => {
  it('writes warnings and errors to the log file with a timestamp, level and pid', () => {
    const { fs, files } = memoryFileSystem();
    const target = fakeConsole();
    const { warn, error } = target;
    persistConsoleWarnings(target, DIRECTORY, fs, 4242);

    target.warn('AUTH: Clearing stored tokens: refresh token rejected by the server (HTTP 401)');
    target.error('AUTH: failed to write the credential vault', 'EACCES');

    const lines = files.get(LOG)?.trimEnd().split('\n') ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z \[warn\] \[pid 4242\] AUTH: Clearing stored tokens/);
    expect(lines[1]).toContain('[error] [pid 4242] AUTH: failed to write the credential vault EACCES');
    // Still reaches the real console too.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('scrubs credentials before they reach the disk', () => {
    const { fs, files } = memoryFileSystem();
    const target = fakeConsole();
    persistConsoleWarnings(target, DIRECTORY, fs);

    target.warn('refresh_token=abcdef0123456789abcdef0123456789abcdef0123456789');

    expect(files.get(LOG)).not.toContain('abcdef0123456789');
  });

  it('rotates the file once it would pass the size cap', () => {
    const { fs, files } = memoryFileSystem(MAX_LOG_BYTES - 10);
    const target = fakeConsole();
    persistConsoleWarnings(target, DIRECTORY, fs);

    target.warn('one more line that does not fit');

    expect(files.get(join(DIRECTORY, ROTATED_LOG_FILE_NAME))?.length).toBe(MAX_LOG_BYTES - 10);
    expect(files.get(LOG)).toContain('one more line');
  });

  it('stops persisting after a write fails, and says so once on the real console', () => {
    const { fs } = memoryFileSystem();
    fs.append = vi.fn(() => {
      throw new Error('ENOSPC');
    });
    const target = fakeConsole();
    const { error } = target;
    persistConsoleWarnings(target, DIRECTORY, fs);

    target.warn('first');
    target.warn('second');

    expect(fs.append).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no longer be persisted'), expect.any(Error));
  });

  it('puts the original console methods back', () => {
    const { fs } = memoryFileSystem();
    const target = fakeConsole();
    const { warn } = target;
    const restore = persistConsoleWarnings(target, DIRECTORY, fs);

    restore();

    expect(target.warn).toBe(warn);
  });
});
