import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileLogger } from './logging';

const directories: string[] = [];
const tempPath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-log-'));
  directories.push(directory);
  return join(directory, 'host.log');
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('createFileLogger', () => {
  it('scrubs credentials from a line before it is written', () => {
    const path = tempPath();

    createFileLogger({ path, verbose: false }).warn('refresh failed, Authorization: Bearer abcdefgh12345678');

    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('abcdefgh12345678');
    expect(written).toContain('WARN');
  });

  it('keeps debug lines out unless verbose', () => {
    const path = tempPath();

    createFileLogger({ path, verbose: false }).debug('noisy');

    expect(existsSync(path)).toBe(false);
  });

  it('rotates by size and keeps the newest lines in a fresh file', () => {
    const path = tempPath();
    const logger = createFileLogger({ path, verbose: true, maxBytes: 200, keep: 2 });

    for (let index = 0; index < 10; index++) logger.warn(`line ${index} ${'x'.repeat(40)}`);

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('line 9');
  });

  it('keeps logging when the file was already rotated away by another process', () => {
    const path = tempPath();
    writeFileSync(path, 'x'.repeat(190));
    const logger = createFileLogger({ path, verbose: true, maxBytes: 200, keep: 2 });
    rmSync(path);

    logger.warn('first after rotation');
    logger.warn('second after rotation');

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('first after rotation');
    expect(written).toContain('second after rotation');
  });

  it('counts bytes, not characters, when deciding to rotate', () => {
    const path = tempPath();
    const logger = createFileLogger({ path, verbose: true, maxBytes: 160, keep: 1 });

    logger.warn('\u00e9'.repeat(30));
    logger.warn('\u00e9'.repeat(30));

    expect(existsSync(`${path}.1`)).toBe(true);
  });
});
