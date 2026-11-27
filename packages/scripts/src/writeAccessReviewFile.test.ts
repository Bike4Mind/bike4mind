import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAccessReviewFile } from './writeAccessReviewFile';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'access-review-file-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('writeAccessReviewFile', () => {
  it('creates a private report and leaves no temporary files', () => {
    const destination = join(directory, 'review.md');
    writeAccessReviewFile(destination, 'private report');
    expect(readFileSync(destination, 'utf8')).toBe('private report');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['review.md']);
  });

  it('replaces a broadly readable existing report with a private file', () => {
    const destination = join(directory, 'review.json');
    writeFileSync(destination, 'old snapshot');
    chmodSync(destination, 0o644);
    writeAccessReviewFile(destination, 'private snapshot');
    expect(readFileSync(destination, 'utf8')).toBe('private snapshot');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['review.json']);
  });

  it('replaces an output symlink without modifying its target', () => {
    const target = join(directory, 'existing.md');
    const destination = join(directory, 'review.md');
    writeFileSync(target, 'preserve this');
    symlinkSync(target, destination);
    writeAccessReviewFile(destination, 'private report');
    expect(readFileSync(target, 'utf8')).toBe('preserve this');
    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('private report');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it('surfaces publication errors and cleans up the private temporary directory', () => {
    const destination = join(directory, 'existing-directory');
    mkdirSync(destination);
    expect(() => writeAccessReviewFile(destination, 'private report')).toThrow();
    expect(readdirSync(directory)).toEqual(['existing-directory']);
    expect(statSync(destination).isDirectory()).toBe(true);
  });

  it('surfaces an unavailable output directory', () => {
    expect(() => writeAccessReviewFile(join(directory, 'missing', 'review.md'), 'report')).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});
