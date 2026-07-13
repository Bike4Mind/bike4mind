import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertConfinedCwd } from './cwd.js';

describe('assertConfinedCwd', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the canonical absolute path for a valid directory', () => {
    expect(assertConfinedCwd(dir)).toBe(realpathSync(dir));
  });

  it('rejects a relative path', () => {
    expect(() => assertConfinedCwd('relative/dir')).toThrow(/absolute/i);
  });

  it('rejects an empty path', () => {
    expect(() => assertConfinedCwd('')).toThrow(/absolute/i);
  });

  it('rejects a non-existent directory', () => {
    expect(() => assertConfinedCwd(join(dir, 'does-not-exist'))).toThrow(/existing directory/i);
  });

  it('rejects a path that is a file, not a directory', () => {
    expect(() => assertConfinedCwd(file)).toThrow(/existing directory/i);
  });
});
