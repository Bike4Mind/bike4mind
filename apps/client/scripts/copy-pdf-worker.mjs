/**
 * Copy the Mozilla pdf.js worker to the public directory.
 *
 * PdfViewer sets `GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'`, i.e. it loads
 * the worker as a plain same-origin static asset. We deliberately do NOT let the bundler
 * wrap the worker: Turbopack's `new Worker(new URL(...))` transform strips `{ type: 'module' }`
 * and boots the worker through a classic-worker `importScripts` shim, which cannot run pdf.js's
 * pre-built ESM worker and leaves `getDocument()` hanging forever.
 *
 * Copying the worker straight out of the installed `pdfjs-dist` guarantees the served worker
 * always matches the `pdfjs-dist` version resolved in node_modules, so the API/worker versions
 * can never drift. CSP `worker-src 'self'` allows the same-origin worker.
 *
 * Runs via pnpm postinstall / predev / prebuild so the asset is always present before a build.
 */

import { copyFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKER_FILE = 'pdf.worker.min.mjs';

function main() {
  // Resolve the worker from the installed package (works with pnpm's nested node_modules).
  const pdfjsPkg = require.resolve('pdfjs-dist/package.json');
  const source = path.join(path.dirname(pdfjsPkg), 'build', WORKER_FILE);

  const destinationDir = path.resolve(__dirname, '../public');
  const destination = path.join(destinationDir, WORKER_FILE);

  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(source, destination);

  console.log(`[copy-pdf-worker] Copied ${WORKER_FILE} -> public/${WORKER_FILE}`);
}

try {
  main();
} catch (error) {
  console.error('[copy-pdf-worker] Failed to copy pdf.js worker:', error);
  process.exit(1);
}
