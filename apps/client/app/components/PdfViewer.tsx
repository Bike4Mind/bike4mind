import { Box, Button, CircularProgress, Typography, useTheme } from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { createPdfWorkerStartError, describePdfLoadError, type PdfLoadErrorDescription } from './pdfLoadError';

// We import the `legacy/` entry point, not pdfjs-dist's default build. The default build is
// compiled for "the latest" browsers and reaches for globals well above this app's Next target:
// it touches `Iterator.prototype` at module scope (a ReferenceError below Safari 18.4) and calls
// `Uint8Array.prototype.toHex` while computing a document fingerprint (Chrome 140 / Firefox 133 /
// Safari 18.2). `legacy/` exposes the identical API with core-js polyfills for both, costing about
// 60KB on a chunk that is only fetched when someone opens a PDF.
//
// Load the worker as a plain same-origin static asset (copied into /public from the installed
// pdfjs-dist by scripts/copy-pdf-worker.mjs, which must copy out of the same build directory this
// import points at, and name it with this same `pdfjsLib.version`). The versioned filename keeps
// the worker URL in step with the installed pdfjs-dist; pdf.js hard-errors on an API/worker
// version mismatch rather than tolerating it.
//
// Each load spawns its own module worker from that URL and hands it to pdf.js as an explicit
// `port`. Another pdf.js copy on the page (e.g. one injected by a browser extension) can set
// `globalThis.pdfjsWorker`, and pdf.js would then silently run that main-thread worker - possibly
// a different version - instead of `workerSrc`. An explicit port bypasses that lookup.
//
// We intentionally pass `new Worker` a plain string URL, NOT `new URL('pdfjs-dist/build/
// pdf.worker.min.mjs', import.meta.url)`: Turbopack rewrites that form into its own worker helper,
// which strips `{ type: 'module' }` and boots the worker through a classic-worker `importScripts`
// shim. That shim can't run pdf.js's pre-built ESM worker, so the worker never initializes and
// `getDocument()` hangs forever on "Loading PDF...". A static file sidesteps the bundler's worker
// transform entirely; CSP `worker-src 'self'` allows it. `workerSrc` is still set as a fallback
// for any other pdf.js call path.
const PDF_WORKER_SRC = `/pdf.worker-${pdfjsLib.version}.min.mjs`;

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
}

// Maximum pages to render at once to prevent memory issues
const MAX_PAGES_TO_RENDER = 50;

type PdfViewerProps = {
  file: string | undefined;
  /**
   * Specify a custom filename
   */
  filename?: string;
};

const BasePdfViewer: FC<PdfViewerProps> = ({ file, filename }) => {
  const theme = useTheme();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PdfLoadErrorDescription | null>(null);
  const [numPages, setNumPages] = useState(0);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfWorkerRef = useRef<pdfjsLib.PDFWorker | null>(null);
  const webWorkerRef = useRef<Worker | null>(null);
  const detachWorkerListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!file) {
      setError({
        title: 'No file provided',
        detail: 'No file was supplied to the PDF viewer, so there is nothing to display.',
        technical: 'No file provided',
      });
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Idempotent: runs on load failure and again from the effect cleanup. Destroying the loading
    // task only tears down the document; pdf.js leaves a caller-supplied PDFWorker alive, and
    // PDFWorker.destroy() never terminates a caller-supplied port, so each is released here.
    const releasePdfResources = () => {
      detachWorkerListenersRef.current?.();
      detachWorkerListenersRef.current = null;
      // destroy() rejects if the worker never finished setting up, which is not actionable here.
      loadingTaskRef.current?.destroy().catch(() => {});
      loadingTaskRef.current = null;
      pdfWorkerRef.current?.destroy();
      pdfWorkerRef.current = null;
      webWorkerRef.current?.terminate();
      webWorkerRef.current = null;
    };

    const loadPdf = async () => {
      try {
        setLoading(true);
        setError(null);

        // Every handle is stored before the await, so an unmount mid-load can still release them.
        const webWorker = new Worker(PDF_WORKER_SRC, { type: 'module' });
        webWorkerRef.current = webWorker;
        // create() rather than the constructor: pdf.js's generated constructor typings declare
        // `port` as null-only. For a fresh port create() just constructs a new PDFWorker.
        const pdfWorker = pdfjsLib.PDFWorker.create({ port: webWorker });
        pdfWorkerRef.current = pdfWorker;
        const loadingTask = pdfjsLib.getDocument({ url: file, worker: pdfWorker });
        loadingTaskRef.current = loadingTask;

        // With an explicit port pdf.js has no startup handshake, so a worker script that fails to
        // load or parse (404, HTML from the SPA fallback, CSP) would leave the load pending
        // forever. Surface it instead; no timeout, since a large PDF on a slow link is legitimate.
        const workerStartFailure = new Promise<never>((_, reject) => {
          const onWorkerError = (event: Event) => reject(createPdfWorkerStartError(event));
          webWorker.addEventListener('error', onWorkerError);
          webWorker.addEventListener('messageerror', onWorkerError);
          detachWorkerListenersRef.current = () => {
            webWorker.removeEventListener('error', onWorkerError);
            webWorker.removeEventListener('messageerror', onWorkerError);
          };
        });

        const pdf = await Promise.race([loadingTask.promise, workerStartFailure]);

        // Only a still-pending load reacts to worker errors; a late one must not replace a document.
        detachWorkerListenersRef.current?.();
        detachWorkerListenersRef.current = null;

        if (cancelled) return;

        setNumPages(pdf.numPages);

        if (canvasContainerRef.current) {
          canvasContainerRef.current.innerHTML = '';

          const pagesToRender = Math.min(pdf.numPages, MAX_PAGES_TO_RENDER);

          if (pdf.numPages > MAX_PAGES_TO_RENDER) {
            console.warn(
              `Large PDF detected (${pdf.numPages} pages). Only rendering first ${MAX_PAGES_TO_RENDER} pages to prevent memory issues.`
            );
          }

          for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
            if (cancelled) return;

            const page = await pdf.getPage(pageNum);

            if (cancelled) return;

            const viewport = page.getViewport({ scale: 1.5 });

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');

            if (!context) {
              throw new Error('Could not get canvas context');
            }

            canvas.height = viewport.height;
            canvas.width = viewport.width;
            canvas.style.display = 'block';
            canvas.style.margin = '0 auto 20px';
            canvas.style.border = `1px solid ${theme.palette.divider}`;

            canvasContainerRef.current?.appendChild(canvas);

            // pdf.js's RenderParameters requires the canvas element itself, not just
            // the 2D context, so pass both.
            const renderContext = {
              canvas,
              canvasContext: context,
              viewport,
            };

            renderTaskRef.current = page.render(renderContext);
            await renderTaskRef.current.promise;

            if (cancelled) return;
          }
        }

        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        releasePdfResources();
        const description = describePdfLoadError(err);
        console.error('Error loading PDF:', err, description.technical);
        setError(description);
        setLoading(false);
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel?.();
      }
      releasePdfResources();
    };
  }, [file, theme.palette.divider]);

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        backgroundColor: 'background.level2',
        padding: 2,
        position: 'relative',
      }}
    >
      {/* Loading overlay */}
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 2,
            backgroundColor: 'background.level2',
            zIndex: 10,
          }}
        >
          <CircularProgress />
          <Typography level="body-sm">Loading PDF...</Typography>
        </Box>
      )}

      {/* Error overlay */}
      {error && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 1.5,
            backgroundColor: 'background.level2',
            zIndex: 10,
            padding: 3,
            textAlign: 'center',
          }}
        >
          <Typography level="title-md" color="danger" data-testid="pdf-viewer-error-title">
            {error.title}
          </Typography>
          <Typography level="body-sm" sx={{ maxWidth: 480 }} data-testid="pdf-viewer-error-detail">
            {error.detail}
          </Typography>
          {file && (
            <Button
              component="a"
              href={file}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="solid"
              color="primary"
              data-testid="pdf-viewer-error-download-btn"
            >
              Download
            </Button>
          )}
          <Typography
            level="body-xs"
            sx={{ color: 'text.tertiary', maxWidth: 480 }}
            data-testid="pdf-viewer-error-technical"
          >
            Technical details: {error.technical}
          </Typography>
        </Box>
      )}

      {/* PDF Controls - only show when loaded */}
      {!loading && !error && filename && (
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            backgroundColor: 'background.surface',
            padding: 1,
            marginBottom: 2,
            borderRadius: 'sm',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Box>
            <Typography level="body-sm">
              {filename} - {numPages} {numPages === 1 ? 'page' : 'pages'}
            </Typography>
            {numPages > MAX_PAGES_TO_RENDER && (
              <Typography level="body-xs" color="warning" sx={{ mt: 0.5 }}>
                Showing first {MAX_PAGES_TO_RENDER} pages. Download for full PDF.
              </Typography>
            )}
          </Box>
          {file && (
            <Button
              component="a"
              href={file}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="solid"
              color="primary"
            >
              Download
            </Button>
          )}
        </Box>
      )}

      {/* PDF Pages Container - always mounted so ref is available during render loop */}
      <Box ref={canvasContainerRef} sx={{ width: '100%' }} />
    </Box>
  );
};

const PdfViewer = dynamic(() => Promise.resolve(BasePdfViewer), {
  ssr: false,
});

export default PdfViewer;
