// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTempFile, zipFiles } from './files';

describe('zipFiles', () => {
  const writtenPaths: string[] = [];

  afterEach(() => {
    for (const p of writtenPaths.splice(0)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('writes the zip to the caller-supplied temp directory path', async () => {
    // Regression: sanitizeFilename used to collapse '/tmp/knowledges.zip' to
    // 'knowledges.zip', so createWriteStream resolved against the Lambda's
    // read-only working directory -> EROFS. The dirname/basename split must
    // preserve the /tmp/ prefix.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
    const outputZip = path.join(dir, 'knowledges.zip');
    writtenPaths.push(dir);

    await zipFiles([], outputZip);

    expect(fs.existsSync(outputZip)).toBe(true);
  });

  it('rejects an output path that resolves outside the temp directory', async () => {
    // The directory portion is taken verbatim, so a traversal that escapes
    // os.tmpdir() (here path.join collapses the '..' segments) must be rejected
    // rather than written to an arbitrary location.
    const outputZip = path.join(os.tmpdir(), '..', '..', 'evil.zip');

    await expect(zipFiles([], outputZip)).rejects.toThrow('Invalid output path');
  });
});

describe('createTempFile', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes inside the supplied base directory', async () => {
    const file = await createTempFile('a.txt', 'hello', baseDir);

    expect(file).toBe(path.join(baseDir, 'a.txt'));
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  it('defaults to the system temp directory', async () => {
    const file = await createTempFile(`files-test-${process.pid}.txt`, 'x');
    try {
      expect(path.dirname(file)).toBe(os.tmpdir());
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('strips directory segments from the file name', async () => {
    const file = await createTempFile('../../evil.txt', 'x', baseDir);

    expect(file).toBe(path.join(baseDir, 'evil.txt'));
  });

  it('rejects a name that resolves outside the base directory', async () => {
    await expect(createTempFile('..', 'x', baseDir)).rejects.toThrow('Invalid file path');
  });
});
