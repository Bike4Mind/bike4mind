// We import the `legacy/` entry point, not pdfjs-dist's default build. The default build is
// compiled for "the latest" browsers and reaches for globals well above this app's Next target:
// it touches `Iterator.prototype` at module scope (a ReferenceError below Safari 18.4) and calls
// `Uint8Array.prototype.toHex` while computing a document fingerprint (Chrome 140 / Firefox 133 /
// Safari 18.2). `legacy/` exposes the identical API with core-js polyfills for both, costing about
// 60KB on a chunk that is only fetched when someone opens a PDF.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { createPdfWorkerFailureError } from './pdfLoadError';

// Load the worker as a plain same-origin static asset (copied into /public from the installed
// pdfjs-dist by scripts/copy-pdf-worker.mjs, which must copy out of the same build directory this
// import points at, and name it with this same `pdfjsLib.version`). The versioned filename keeps
// the worker URL in step with the installed pdfjs-dist; pdf.js hard-errors on an API/worker
// version mismatch rather than tolerating it.
//
// Each load spawns its own module worker from that URL and hands it to pdf.js as an explicit
// `port`. `unpdf` (lazily imported by `extractTextFromFile` in app/utils/fabFileUtils.tsx, only
// when a PDF is actually extracted) bundles its own pdf.js and sets `globalThis.pdfjsWorker` on
// load, and pdf.js would then silently run that main-thread worker - a different version -
// instead of `workerSrc`. Once unpdf has loaded in a session that global stays set, and any
// mismatch with unpdf's bundled version breaks every PDF view (it did when our pdfjs-dist moved
// to v6). An explicit port bypasses that lookup, so open every document through openPdfDocument.
//
// We intentionally pass `new Worker` a plain string URL, NOT `new URL('pdfjs-dist/build/
// pdf.worker.min.mjs', import.meta.url)`: Turbopack rewrites that form into its own worker helper,
// which strips `{ type: 'module' }` and boots the worker through a classic-worker `importScripts`
// shim. That shim can't run pdf.js's pre-built ESM worker, so the worker never initializes and
// `getDocument()` hangs forever on "Loading PDF...". A static file sidesteps the bundler's worker
// transform entirely; CSP `worker-src 'self'` allows it. `workerSrc` is set only because pdf.js
// requires it to be defined.
export const PDF_WORKER_SRC = `/pdf.worker-${pdfjsLib.version}.min.mjs`;

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
}

// Data files the worker fetches on demand, copied alongside it by scripts/copy-pdf-worker.mjs.
// Missing ones are not an error to pdf.js: JPEG 2000 / JBIG2 images render blank, non-embedded
// standard fonts fall back to a substitute and CJK text without embedded fonts goes missing.
const PDF_ASSETS_BASE = `/pdfjs-assets-${pdfjsLib.version}`;
export const PDF_ASSET_URLS = {
  wasmUrl: `${PDF_ASSETS_BASE}/wasm/`,
  standardFontDataUrl: `${PDF_ASSETS_BASE}/standard_fonts/`,
  cMapUrl: `${PDF_ASSETS_BASE}/cmaps/`,
  cMapPacked: true,
  iccUrl: `${PDF_ASSETS_BASE}/iccs/`,
};

export interface OpenedPdf {
  loadingTask: PDFDocumentLoadingTask;
  /**
   * Rejects when the worker dies. With an explicit port pdf.js has no startup handshake, so a
   * worker script that fails to load or parse (404, HTML from the SPA fallback, CSP) - or that
   * crashes partway through rendering - would otherwise leave every pending pdf.js call hanging.
   * Race it against each await. Never an unhandled rejection when nothing races it.
   */
  workerDeath: Promise<never>;
  /** Stop reporting worker failures, e.g. once rendering finished and a late error must not count. */
  stopWatchingWorker: () => void;
  /**
   * Idempotent. Destroying the loading task only tears down the document; pdf.js leaves a
   * caller-supplied PDFWorker alive, and PDFWorker.destroy() never terminates a caller-supplied
   * port, so each is released here.
   */
  release: () => void;
}

/** Open a PDF on its own worker. Every handle exists on return, so a caller can release before any await. */
export function openPdfDocument(source: { url: string } | { data: Uint8Array }): OpenedPdf {
  const webWorker = new Worker(PDF_WORKER_SRC, { type: 'module' });
  // create() rather than the constructor: pdf.js's generated constructor typings declare
  // `port` as null-only. For a fresh port create() just constructs a new PDFWorker.
  const pdfWorker = pdfjsLib.PDFWorker.create({ port: webWorker });
  const loadingTask = pdfjsLib.getDocument({ ...source, worker: pdfWorker, ...PDF_ASSET_URLS });

  let rejectWorkerDeath!: (error: Error) => void;
  const workerDeath = new Promise<never>((_, reject) => {
    rejectWorkerDeath = reject;
  });
  workerDeath.catch(() => {});

  const onWorkerError = (event: Event) => rejectWorkerDeath(createPdfWorkerFailureError(event));
  webWorker.addEventListener('error', onWorkerError);
  webWorker.addEventListener('messageerror', onWorkerError);
  const stopWatchingWorker = () => {
    webWorker.removeEventListener('error', onWorkerError);
    webWorker.removeEventListener('messageerror', onWorkerError);
  };

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopWatchingWorker();
    // destroy() rejects if the worker never finished setting up, which is not actionable here.
    loadingTask.destroy().catch(() => {});
    pdfWorker.destroy();
    webWorker.terminate();
  };

  return { loadingTask, workerDeath, stopWatchingWorker, release };
}
