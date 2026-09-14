import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pdf.js v6 removed the two calling conventions this component used to rely on: `getDocument` no
// longer accepts a bare URL string, and `PDFDocumentProxy.destroy` is gone. The real build cannot
// run here (its worker needs browser features jsdom lacks), so the doubles below are keyed off the
// real v6 types with `Pick`: if pdf.js renames or drops a member the component calls, these stop
// compiling rather than silently passing against a hand-rolled shape.
type LoadingTaskDouble = Pick<PDFDocumentLoadingTask, 'promise' | 'destroy'>;
type DocumentDouble = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>;
type PageDouble = Pick<PDFPageProxy, 'getViewport' | 'render'>;
type RenderTaskDouble = Pick<RenderTask, 'promise' | 'cancel'>;

const destroy = vi.fn<LoadingTaskDouble['destroy']>();
const cancel = vi.fn<RenderTaskDouble['cancel']>();
const getPage = vi.fn<(pageNumber: number) => void>();
const getDocument = vi.fn<(src: { url: string }) => LoadingTaskDouble>();

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (src: { url: string }) => getDocument(src),
}));

vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    let Loaded: React.FC<Record<string, unknown>> | null = null;
    void Promise.resolve(loader()).then(mod => {
      Loaded = (mod as { default?: React.FC }).default ?? (mod as React.FC);
    });
    return (props: Record<string, unknown>) => (Loaded ? <Loaded {...props} /> : null);
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// `PageViewport` and the others carry far more than the component reads, so each double is widened
// to the real type at the single point it is handed over. Assertions only, never `as unknown as`.
const viewport = { width: 120, height: 160 } as PageViewport;

const makePage = (): PageDouble => ({
  getViewport: () => viewport,
  render: () => ({ promise: Promise.resolve(), cancel }) as RenderTask,
});

const makeDocument = (numPages: number): DocumentDouble => ({
  numPages,
  getPage: async pageNumber => {
    getPage(pageNumber);
    return makePage() as PDFPageProxy;
  },
});

const loadsDocument = (numPages = 2) =>
  getDocument.mockImplementation(() => ({
    destroy,
    promise: Promise.resolve(makeDocument(numPages) as PDFDocumentProxy),
  }));

const FILE = 'https://example.test/doc.pdf';
const importViewer = async () => (await import('./PdfViewer')).default;

describe('PdfViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroy.mockResolvedValue(undefined);
    loadsDocument();
    // jsdom has no 2D backend; the component bails out when getContext returns null.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the file to getDocument as a parameter object', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(getDocument).toHaveBeenCalledWith({ url: FILE });
  });

  it('renders every page and reports the page count', async () => {
    const PdfViewer = await importViewer();
    const { container } = render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByText(/doc\.pdf - 2 pages/)).toBeInTheDocument());
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1, 2]);
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
  });

  it('tears the document down through the loading task on unmount', async () => {
    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} />, { wrapper: TestWrapper });

    await waitFor(() => expect(getPage).toHaveBeenCalled());
    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('terminates the worker when unmounted before the document resolves', async () => {
    getDocument.mockImplementation(() => ({ destroy, promise: new Promise(() => {}) }));

    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalled());
    expect(getPage).not.toHaveBeenCalled();
    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('swallows a teardown rejection rather than leaving it unhandled', async () => {
    destroy.mockRejectedValue(new Error('worker never set up'));

    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} />, { wrapper: TestWrapper });

    await waitFor(() => expect(getPage).toHaveBeenCalled());
    expect(() => unmount()).not.toThrow();
    await expect(destroy.mock.results[0]!.value).rejects.toThrow('worker never set up');
  });

  it('shows the error message when the document fails to load', async () => {
    getDocument.mockImplementation(() => ({
      destroy,
      promise: Promise.reject(new Error('Invalid parameter object')),
    }));

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByText(/Unable to load PDF document/)).toBeInTheDocument());
    expect(screen.queryByText(/Loading PDF/)).not.toBeInTheDocument();
  });

  it('reports an error when no file is supplied', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={undefined} />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByText(/No file provided/)).toBeInTheDocument());
    expect(getDocument).not.toHaveBeenCalled();
  });
});
