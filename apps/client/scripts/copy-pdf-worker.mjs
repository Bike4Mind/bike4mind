/**
 * Copy the Mozilla pdf.js worker to the public directory.
 *
 * PdfViewer sets `GlobalWorkerOptions.workerSrc = \`/pdf.worker-${pdfjsLib.version}.min.mjs\``,
 * i.e. it loads the worker as a plain same-origin static asset. We deliberately do NOT let the
 * bundler wrap the worker: Turbopack's `new Worker(new URL(...))` transform strips
 * `{ type: 'module' }` and boots the worker through a classic-worker `importScripts` shim, which
 * cannot run pdf.js's pre-built ESM worker and leaves `getDocument()` hanging forever.
 *
 * The destination filename carries the resolved `pdfjs-dist` version (e.g.
 * `pdf.worker-6.3.289.min.mjs`). Some client-side cache keyed by the URL (browser HTTP cache, a
 * service worker, or a CDN edge - which layer held it is not known) can keep a returning visitor
 * running an old worker build after we ship a new `pdfjs-dist` - pdf.js then refuses to run,
 * since it hard-errors on an API/worker version mismatch. Baking the version into the filename
 * gives a version bump a fresh URL that no URL-keyed cache can hold stale. Any other
 * `pdf.worker*.mjs` left over from a prior version is removed so a stale worker never ships
 * alongside the new one.
 *
 * We also copy the same bytes to the unversioned `pdf.worker.min.mjs`. A tab that loaded the
 * pre-deploy bundle keeps requesting that legacy name until it reloads; without it, prod's
 * fallback of serving the SPA's HTML for a missing public file would hand that tab HTML as its
 * worker. The legacy name only serves tabs loaded before the versioned URL shipped and can be
 * dropped in a later release.
 *
 * Runs via pnpm postinstall / predev / prebuild so the asset is always present before a build.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
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

function main() {
  // Resolve the worker from the installed package (works with pnpm's nested node_modules).
  const pdfjsPkg = require.resolve('pdfjs-dist/package.json');
  const pdfjsDir = path.dirname(pdfjsPkg);
  const { version } = JSON.parse(readFileSync(pdfjsPkg, 'utf8'));
  const source = path.join(pdfjsDir, BUILD_DIR, SOURCE_WORKER_FILE);

  // Accepts an optional destination directory (process.argv[2]) so the copy can be tested
  // against a scratch directory instead of the real public/ folder.
  const destinationDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../public');
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
}

try {
  main();
} catch (error) {
  console.error('[copy-pdf-worker] Failed to copy pdf.js worker:', error);
  process.exit(1);
}
