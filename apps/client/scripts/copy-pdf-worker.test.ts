// @vitest-environment node
import { describe, expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The real `version` pdfjs-dist exports at runtime - importing it here (rather than reading
// package.json) is what proves the script's output filename matches what PdfViewer actually
// requests via `pdfjsLib.version`.
import { version } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SCRIPT = fileURLToPath(new URL('./copy-pdf-worker.mjs', import.meta.url));

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const REAL_WORKER = path.join(pdfjsDir, 'legacy', 'build', 'pdf.worker.min.mjs');
const REAL_WORKER_BYTES = fs.readFileSync(REAL_WORKER);

const VERSIONED_NAME = `pdf.worker-${version}.min.mjs`;
const LEGACY_NAME = 'pdf.worker.min.mjs';

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-pdf-worker-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const run = (destinationDir: string) => spawnSync(process.execPath, [SCRIPT, destinationDir], { encoding: 'utf8' });

describe('copy-pdf-worker.mjs', () => {
  it('replaces a stale versioned worker and keeps an unrelated file, leaving exactly the versioned and legacy names', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'pdf.worker-5.6.205.min.mjs'), 'stale worker');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'not a worker file');

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(['keep.txt', VERSIONED_NAME, LEGACY_NAME].sort());
  });

  it('writes both worker files byte-identical to the installed pdfjs-dist worker', () => {
    const dir = makeTempDir();

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, VERSIONED_NAME))).toEqual(REAL_WORKER_BYTES);
    expect(fs.readFileSync(path.join(dir, LEGACY_NAME))).toEqual(REAL_WORKER_BYTES);
  });

  it('is idempotent: running twice leaves only the current versioned and legacy names behind', () => {
    const dir = makeTempDir();

    run(dir);
    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual([VERSIONED_NAME, LEGACY_NAME].sort());
  });
});
