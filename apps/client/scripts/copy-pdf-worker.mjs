/**
 * Copy the Mozilla pdf.js worker to the public directory.
 *
 * PdfViewer loads the worker from `/pdf.worker-${pdfjsLib.version}.min.mjs` (its own module
 * worker per load, plus `GlobalWorkerOptions.workerSrc`), i.e. as a plain same-origin static
 * asset. We deliberately do NOT let the bundler wrap the worker: Turbopack's
 * `new Worker(new URL(...))` transform strips `{ type: 'module' }` and boots the worker through a
 * classic-worker `importScripts` shim, which cannot run pdf.js's pre-built ESM worker and leaves
 * `getDocument()` hanging forever.
 *
 * The destination filename carries the resolved `pdfjs-dist` version (e.g.
 * `pdf.worker-6.3.289.min.mjs`), keeping the worker URL in step with the installed `pdfjs-dist`;
 * pdf.js hard-errors on an API/worker version mismatch rather than tolerating it. Any other
 * `pdf.worker*.mjs` left over from a prior version is removed so a stale worker never ships
 * alongside the new one.
 *
 * We also copy the same bytes to the unversioned `pdf.worker.min.mjs`. A tab that loaded the
 * pre-deploy bundle keeps requesting that legacy name until it reloads; without it, prod's
 * fallback of serving the SPA's HTML for a missing public file would hand that tab HTML as its
 * worker. The legacy name only serves tabs loaded before the versioned URL shipped and can be
 * dropped in a later release.
 *
 * The worker also fetches data files at runtime: wasm image decoders and color management
 * (`wasmUrl`), glyphs for the 14 standard fonts (`standardFontDataUrl`), CJK character maps
 * (`cMapUrl`) and the CMYK ICC profile (`iccUrl`). Without them pdf.js only warns and renders with
 * gaps. They are copied into `pdfjs-assets-${version}/`, versioned like the worker so the data
 * always matches it, and any other `pdfjs-assets-*` directory is removed.
 *
 * Runs via pnpm postinstall / predev / prebuild so the asset is always present before a build.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_WORKER_FILE = 'pdf.worker.min.mjs';

// Must stay in step with PdfViewer's `pdfjs-dist/legacy/build/pdf.mjs` import: pdf.js refuses to
// run an API and a worker from different builds, and the polyfills the legacy build relies on live
// in the legacy worker.
const BUILD_DIR = path.join('legacy', 'build');

// Top-level pdfjs-dist directories (the legacy build has no copies of its own). Each is served as
// `/pdfjs-assets-${version}/<dir>/`, the URLs PdfViewer passes to getDocument.
const ASSET_DIRS = ['wasm', 'standard_fonts', 'cmaps', 'iccs'];
const ASSETS_DIR_PREFIX = 'pdfjs-assets-';
// pdf.js's scripting sandbox (a JS interpreter), which PdfViewer never enables; not worth serving.
const UNUSED_WASM_PREFIX = 'quickjs-';
const TEMP_SUFFIX = '.tmp';
const TEMP_MAX_AGE_MS = 10 * 60 * 1000;
const COMPLETE_MARKER = '.complete';
const SWAP_ATTEMPTS = 3;

function main() {
  // Resolve the worker from the installed package (works with pnpm's nested node_modules).
  // An optional pdfjs-dist root (process.argv[3]) lets tests point at a package missing a directory.
  const pdfjsDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjsPkg = path.join(pdfjsDir, 'package.json');
  const { version } = JSON.parse(readFileSync(pdfjsPkg, 'utf8'));
  const source = path.join(pdfjsDir, BUILD_DIR, SOURCE_WORKER_FILE);

  // Accepts an optional destination directory (process.argv[2]) so the copy can be tested
  // against a scratch directory instead of the real public/ folder.
  const destinationDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../public');
  const versionedFile = `pdf.worker-${version}.min.mjs`;
  const keptFiles = new Set([versionedFile, SOURCE_WORKER_FILE]);

  mkdirSync(destinationDir, { recursive: true });

  for (const entry of readdirSync(destinationDir)) {
    if (/^pdf\.worker.*\.mjs$/.test(entry) && !keptFiles.has(entry)) {
      unlinkSync(path.join(destinationDir, entry));
      console.log(`[copy-pdf-worker] Removed stale public/${entry}`);
    }
  }

  copyFileSync(source, path.join(destinationDir, versionedFile));
  console.log(`[copy-pdf-worker] Copied ${SOURCE_WORKER_FILE} -> public/${versionedFile}`);

  // Legacy unversioned name, kept alongside the versioned one during the deploy transition (see
  // file header).
  copyFileSync(source, path.join(destinationDir, SOURCE_WORKER_FILE));
  console.log(`[copy-pdf-worker] Copied ${SOURCE_WORKER_FILE} -> public/${SOURCE_WORKER_FILE}`);

  const assetsDir = `${ASSETS_DIR_PREFIX}${version}`;
  const finalDir = path.join(destinationDir, assetsDir);
  for (const entry of readdirSync(destinationDir)) {
    if (!entry.startsWith(ASSETS_DIR_PREFIX) || entry === assetsDir) continue;
    const entryPath = path.join(destinationDir, entry);
    // A live run's private temp dir is recent; only an abandoned one (killed run) is swept.
    const stat = entry.endsWith(TEMP_SUFFIX) ? statSync(entryPath, { throwIfNoEntry: false }) : null;
    if (entry.endsWith(TEMP_SUFFIX) && !stat) continue;
    if (stat && Date.now() - stat.mtimeMs < TEMP_MAX_AGE_MS) continue;
    rmSync(entryPath, { recursive: true, force: true });
    console.log(`[copy-pdf-worker] Removed stale public/${entry}`);
  }

  // Build in a private sibling, mark it complete, then swap it in by rename. Overlapping runs
  // (postinstall vs predev/prebuild) never delete a directory another run is still walking, and a
  // directory carrying the marker is always whole.
  const tempDir = `${finalDir}.${process.pid}${TEMP_SUFFIX}`;
  const oldDir = `${finalDir}.${process.pid}.old${TEMP_SUFFIX}`;
  const isComplete = () => existsSync(path.join(finalDir, COMPLETE_MARKER));
  if (isComplete()) return;
  try {
    for (const dir of ASSET_DIRS) {
      cpSync(path.join(pdfjsDir, dir), path.join(tempDir, dir), {
        recursive: true,
        filter: source => !path.basename(source).startsWith(UNUSED_WASM_PREFIX),
      });
    }
    writeFileSync(path.join(tempDir, COMPLETE_MARKER), '');
    for (let attempt = 1; ; attempt++) {
      rmSync(oldDir, { recursive: true, force: true });
      if (isComplete()) return;
      try {
        renameSync(finalDir, oldDir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        renameSync(tempDir, finalDir);
        break;
      } catch (error) {
        const lostRace = error.code === 'ENOTEMPTY' || error.code === 'EEXIST';
        // A concurrent run renamed its own whole copy into place first.
        if (lostRace && isComplete()) break;
        if (!lostRace) {
          // An unrelated rename error must not leave the previous copy deleted by the finally.
          if (existsSync(oldDir) && !existsSync(finalDir)) {
            try {
              renameSync(oldDir, finalDir);
            } catch {
              /* best effort */
            }
          }
          throw error;
        }
        if (attempt === SWAP_ATTEMPTS) throw error;
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
  console.log(`[copy-pdf-worker] Copied ${ASSET_DIRS.join(', ')} -> public/${assetsDir}/`);
}

try {
  main();
} catch (error) {
  console.error('[copy-pdf-worker] Failed to copy pdf.js worker:', error);
  process.exit(1);
}
