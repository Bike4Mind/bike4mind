import { Box, Button, CircularProgress, Typography, useTheme } from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

// Load the worker as a plain same-origin static asset (copied into /public from the installed
// pdfjs-dist by scripts/copy-pdf-worker.mjs). pdf.js instantiates the module worker itself from
// this URL.
//
// We intentionally do NOT use `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs',
// import.meta.url), { type: 'module' })`: Turbopack rewrites that into its own worker helper,
// which strips `{ type: 'module' }` and boots the worker through a classic-worker `importScripts`
// shim. That shim can't run pdf.js's pre-built ESM worker, so the worker never initializes and
// `getDocument()` hangs forever on "Loading PDF...". Pointing `workerSrc` at a
// static file sidesteps the bundler's worker transform entirely; CSP `worker-src 'self'` allows
// it, and the copied file always matches the resolved pdfjs-dist version.
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
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
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    if (!file) {
      setError('No file provided');
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadPdf = async () => {
      try {
        setLoading(true);
        setError(null);

        const loadingTask = pdfjsLib.getDocument(file);
        const pdf = await loadingTask.promise;

        if (cancelled) return;

        // Store PDF reference for cleanup
        pdfDocRef.current = pdf;
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

            // pdf.js v5's RenderParameters requires the canvas element itself, not just
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
        console.error('Error loading PDF:', err);
        setError('Unable to load PDF document. Please try again or download the file.');
        setLoading(false);
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel?.();
      }
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
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
            gap: 2,
            backgroundColor: 'background.level2',
            zIndex: 10,
          }}
        >
          <Typography level="body-sm" color="danger">
            {error}
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
            <Button component="a" href={file} download={filename} size="sm" variant="solid" color="primary">
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
