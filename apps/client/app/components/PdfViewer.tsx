import { Box, Button, CircularProgress, Typography, useTheme } from '@mui/joy';
import { FC, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { RenderTask } from 'pdfjs-dist';
import { describePdfLoadError, type PdfLoadErrorDescription } from './pdfLoadError';
import { openPdfDocument, type OpenedPdf } from './pdfjsAssets';

// Every document is opened through openPdfDocument (pdfjsAssets.ts), which documents the pdf.js
// build and worker setup.

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

    // Every handle from this run only, so a stale run can never release or detach a later run's
    // resources (each effect run gets its own `resources` via closure, unlike a component-level ref).
    const resources: { pdf: OpenedPdf | null; renderTask: RenderTask | null } = { pdf: null, renderTask: null };

    // Runs on load failure and again from the effect cleanup; OpenedPdf.release is idempotent.
    const releasePdfResources = () => resources.pdf?.release();

    const loadPdf = async () => {
      try {
        setLoading(true);
        setError(null);

        // Stored before the await, so an unmount mid-load can still release it.
        const opened = openPdfDocument({ url: file });
        resources.pdf = opened;
        const { loadingTask, workerDeath } = opened;

        // Raced against every awaited pdf.js call below, from the initial load through the last
        // page render. No timeout, since a large PDF on a slow link is legitimate.
        const pdf = await Promise.race([loadingTask.promise, workerDeath]);

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

            const page = await Promise.race([pdf.getPage(pageNum), workerDeath]);

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

            resources.renderTask = page.render(renderContext);
            await Promise.race([resources.renderTask.promise, workerDeath]);

            if (cancelled) return;
          }
        }

        // Only a still-rendering load reacts to worker failure; once rendering has finished, a
        // later error must not replace an already-rendered document.
        opened.stopWatchingWorker();

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
      resources.renderTask?.cancel?.();
      releasePdfResources();
    };
  }, [file, theme.palette.divider]);

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        backgroundColor: 'background.level2',
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

      {/* Scroll region - holds the rendered pages. The root itself no longer scrolls, so the info
          bar below sits as a normal flex item instead of needing a scroll container to pin
          "sticky" against (a host that does not constrain the viewer's height left sticky with
          nothing to pin to). */}
      <Box
        data-testid="pdf-viewer-scroll-area"
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          padding: 2,
        }}
      >
        {/* PDF Pages Container - always mounted so ref is available during render loop */}
        <Box ref={canvasContainerRef} sx={{ width: '100%' }} />
      </Box>

      {/* File info bar - a compact footer after the scroll area, not inside it, so it never
          overlaps the pages while scrolling and always lands at the bottom even for a short PDF. */}
      {!loading && !error && filename && (
        <Box
          data-testid="pdf-viewer-info-bar"
          sx={{
            flexShrink: 0,
            backgroundColor: 'background.surface',
            borderTop: '1px solid',
            borderColor: 'divider',
            px: 1.5,
            py: 0.5,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography level="body-xs" noWrap>
              {filename} - {numPages} {numPages === 1 ? 'page' : 'pages'}
            </Typography>
            {numPages > MAX_PAGES_TO_RENDER && (
              <Typography level="body-xs" color="warning" noWrap>
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
              sx={{ flexShrink: 0 }}
              data-testid="pdf-viewer-download-btn"
            >
              Download
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
};

const PdfViewer = dynamic(() => Promise.resolve(BasePdfViewer), {
  ssr: false,
});

export default PdfViewer;
