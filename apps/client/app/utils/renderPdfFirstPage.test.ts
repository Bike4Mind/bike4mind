import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openPdfDocument, release } = vi.hoisted(() => ({ openPdfDocument: vi.fn(), release: vi.fn() }));
vi.mock('@client/app/components/pdfjsAssets', () => ({ openPdfDocument }));

import { renderPdfFirstPage } from './renderPdfFirstPage';

const pdfFile = () => new File(['%PDF-1.7'], 'doc.pdf', { type: 'application/pdf' });

/** An opened document whose load never settles unless the worker dies. */
const hangingDocument = (workerDeath: Promise<never> = new Promise(() => {})) => ({
  loadingTask: { promise: new Promise(() => {}) },
  workerDeath,
  stopWatchingWorker: vi.fn(),
  release,
});

describe('renderPdfFirstPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects and releases the worker when aborted mid-load', async () => {
    openPdfDocument.mockReturnValue(hangingDocument());
    const controller = new AbortController();

    const rendering = renderPdfFirstPage(pdfFile(), 100, controller.signal);
    await vi.waitFor(() => expect(openPdfDocument).toHaveBeenCalled());
    controller.abort();

    await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects and releases the worker when the worker dies', async () => {
    const death = Promise.reject(new Error('PDF worker stopped'));
    death.catch(() => {});
    openPdfDocument.mockReturnValue(hangingDocument(death));

    await expect(renderPdfFirstPage(pdfFile(), 100)).rejects.toThrow('PDF worker stopped');
    expect(release).toHaveBeenCalledOnce();
  });

  it('never opens a worker when aborted before the file was read', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(renderPdfFirstPage(pdfFile(), 100, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(openPdfDocument).not.toHaveBeenCalled();
  });
});
