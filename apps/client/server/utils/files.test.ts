// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipFiles } from './files';

describe('zipFiles', () => {
  const writtenPaths: string[] = [];

  afterEach(() => {
    for (const p of writtenPaths.splice(0)) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  });

  it('writes the zip to the caller-supplied temp directory path', async () => {
    // Regression: sanitizeFilename used to collapse '/tmp/knowledges.zip' to
    // 'knowledges.zip', so createWriteStream resolved against the Lambda's
    // read-only working directory -> EROFS. The dirname/basename split must
    // preserve the /tmp/ prefix.
    const outputZip = path.join(os.tmpdir(), 'knowledges.zip');
    writtenPaths.push(outputZip);

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
