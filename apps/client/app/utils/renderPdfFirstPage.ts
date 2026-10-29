/**
 * Draw page 1 of a local PDF onto a new canvas, scaled so it covers a `size`-px square.
 * pdf.js is imported here, on first use, so it stays out of the bundles that only show the result.
 */
export async function renderPdfFirstPage(file: File, size: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  const { openPdfDocument } = await import('@client/app/components/pdfjsAssets');
  const data = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();

  const { loadingTask, workerDeath, release } = openPdfDocument({ data });
  const aborted = new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const stopped = Promise.race([workerDeath, aborted]);
  stopped.catch(() => {});

  try {
    const pdf = await Promise.race([loadingTask.promise, stopped]);
    const page = await Promise.race([pdf.getPage(1), stopped]);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = (size / Math.min(unscaled.width, unscaled.height)) * (window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) throw new Error('Canvas 2D context unavailable');
    await Promise.race([page.render({ canvas, canvasContext, viewport }).promise, stopped]);
    return canvas;
  } finally {
    release();
  }
}
