// @vitest-environment node
import { describe, expect, it, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
// Must match the asset URLs PdfViewer passes to getDocument.
const ASSETS_NAME = `pdfjs-assets-${version}`;
const ASSET_DIRS = ['cmaps', 'iccs', 'standard_fonts', 'wasm'];

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-pdf-worker-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const run = (destinationDir: string, pdfjsRoot?: string) =>
  spawnSync(process.execPath, [SCRIPT, destinationDir, ...(pdfjsRoot ? [pdfjsRoot] : [])], { encoding: 'utf8' });

describe('copy-pdf-worker.mjs', () => {
  it('replaces a stale versioned worker and keeps an unrelated file, leaving exactly the versioned and legacy names', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'pdf.worker-5.6.205.min.mjs'), 'stale worker');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'not a worker file');

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(['keep.txt', VERSIONED_NAME, LEGACY_NAME, ASSETS_NAME].sort());
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
    expect(fs.readdirSync(dir).sort()).toEqual([VERSIONED_NAME, LEGACY_NAME, ASSETS_NAME].sort());
  });

  it('copies the wasm, standard font, cmap and ICC directories byte-identical into the versioned assets directory', () => {
    const dir = makeTempDir();

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(path.join(dir, ASSETS_NAME)).sort()).toEqual(ASSET_DIRS);
    for (const file of [
      'wasm/openjpeg.wasm',
      'standard_fonts/FoxitSerif.pfb',
      'cmaps/UniJIS-UCS2-H.bcmap',
      'iccs/CGATS001Compat-v2-micro.icc',
    ]) {
      expect(fs.readFileSync(path.join(dir, ASSETS_NAME, file))).toEqual(fs.readFileSync(path.join(pdfjsDir, file)));
    }
    const expectedWasm = fs.readdirSync(path.join(pdfjsDir, 'wasm')).filter(f => !f.startsWith('quickjs-'));
    expect(fs.readdirSync(path.join(dir, ASSETS_NAME, 'wasm')).sort()).toEqual(expectedWasm.sort());
  });

  it('exits 1 and leaves no assets directory when a pdfjs-dist asset directory is missing', () => {
    const dir = makeTempDir();
    const fakeRoot = makeTempDir();
    fs.copyFileSync(path.join(pdfjsDir, 'package.json'), path.join(fakeRoot, 'package.json'));
    fs.mkdirSync(path.join(fakeRoot, 'legacy', 'build'), { recursive: true });
    fs.copyFileSync(REAL_WORKER, path.join(fakeRoot, 'legacy', 'build', 'pdf.worker.min.mjs'));
    for (const d of ['wasm', 'standard_fonts', 'cmaps'])
      fs.cpSync(path.join(pdfjsDir, d), path.join(fakeRoot, d), { recursive: true });

    const result = run(dir, fakeRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[copy-pdf-worker] Failed to copy');
    expect(fs.readdirSync(dir).filter(f => f.startsWith('pdfjs-assets-'))).toEqual([]);
  });

  it('survives overlapping runs on the same directory', async () => {
    const dir = makeTempDir();
    const runAsync = () =>
      new Promise<number | null>(resolve => {
        spawn(process.execPath, [SCRIPT, dir], { stdio: 'ignore' }).on('close', resolve);
      });

    const codes = await Promise.all([runAsync(), runAsync(), runAsync()]);

    expect(codes).toEqual([0, 0, 0]);
    expect(fs.readdirSync(dir).sort()).toEqual([VERSIONED_NAME, LEGACY_NAME, ASSETS_NAME].sort());
  });

  it('removes a stale versioned assets directory and refreshes the current one', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'pdfjs-assets-5.6.205', 'cmaps'), { recursive: true });
    fs.mkdirSync(path.join(dir, ASSETS_NAME, 'cmaps'), { recursive: true });
    fs.writeFileSync(path.join(dir, ASSETS_NAME, 'cmaps', 'leftover.bcmap'), 'stale');

    const result = run(dir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'pdfjs-assets-5.6.205'))).toBe(false);
    expect(fs.existsSync(path.join(dir, ASSETS_NAME, 'cmaps', 'leftover.bcmap'))).toBe(false);
  });
});
