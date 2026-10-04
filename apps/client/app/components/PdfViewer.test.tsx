import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
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
const getDocument = vi.fn<(src: { url: string; worker?: unknown }) => LoadingTaskDouble>();

// vi.hoisted runs before vi.mock's factory, which is itself hoisted above this file's other
// top-level statements - the one source for the version both the mock and the assertions below
// read, instead of a hand-duplicated literal.
const { mockPdfjsVersion, PDFWorkerDouble } = vi.hoisted(() => {
  class PDFWorkerDouble {
    static instances: PDFWorkerDouble[] = [];
    destroy = vi.fn();
    constructor(public params: { port?: unknown }) {
      PDFWorkerDouble.instances.push(this);
    }
    static create(params: { port?: unknown }) {
      return new PDFWorkerDouble(params);
    }
  }
  return { mockPdfjsVersion: '6.3.289', PDFWorkerDouble };
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  version: mockPdfjsVersion,
  PDFWorker: PDFWorkerDouble,
  getDocument: (src: { url: string; worker?: unknown }) => getDocument(src),
}));

// jsdom has no Worker; this double records how the component spawns the pdf.js worker and, as an
// EventTarget, lets a test fire the `error` a real Worker emits when its script fails to load.
class WorkerDouble extends EventTarget {
  static instances: WorkerDouble[] = [];
  terminate = vi.fn();
  constructor(
    public url: string,
    public options?: WorkerOptions
  ) {
    super();
    WorkerDouble.instances.push(this);
  }
}

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
const FILE_B = 'https://example.test/doc-b.pdf';
const importViewer = async () => (await import('./PdfViewer')).default;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PdfViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PDFWorkerDouble.instances = [];
    WorkerDouble.instances = [];
    vi.stubGlobal('Worker', WorkerDouble);
    destroy.mockResolvedValue(undefined);
    loadsDocument();
    // jsdom has no 2D backend; the component bails out when getContext returns null.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const expectAllReleased = () => {
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(PDFWorkerDouble.instances).toHaveLength(1);
    expect(PDFWorkerDouble.instances[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(WorkerDouble.instances).toHaveLength(1);
    expect(WorkerDouble.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  };

  it('points the worker at a filename carrying the pdfjs-dist version', async () => {
    await importViewer();
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBe(`/pdf.worker-${mockPdfjsVersion}.min.mjs`);
  });

  it('passes the file to getDocument as a parameter object', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(getDocument).toHaveBeenCalledWith({ url: FILE, worker: PDFWorkerDouble.instances[0] });
  });

  it('hands pdf.js a dedicated module worker as an explicit port', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(WorkerDouble.instances).toHaveLength(1);
    const webWorker = WorkerDouble.instances[0]!;
    expect(webWorker.url).toBe(`/pdf.worker-${mockPdfjsVersion}.min.mjs`);
    expect(webWorker.options).toEqual({ type: 'module' });
    expect(PDFWorkerDouble.instances).toHaveLength(1);
    const pdfWorker = PDFWorkerDouble.instances[0]!;
    expect(pdfWorker.params).toEqual({ port: webWorker });
    expect(getDocument.mock.calls[0]![0]).toEqual({ url: FILE, worker: pdfWorker });
    expect(getDocument.mock.calls[0]![0].worker).toBe(pdfWorker);
  });

  it('still uses its own worker when another pdf.js copy has set globalThis.pdfjsWorker', async () => {
    // Shape an injected pdf.js leaves behind; pdf.js would otherwise prefer it over workerSrc.
    vi.stubGlobal('pdfjsWorker', { WorkerMessageHandler: {} });

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(PDFWorkerDouble.instances[0]!.params).toEqual({ port: WorkerDouble.instances[0] });
    expect(getDocument.mock.calls[0]![0].worker).toBe(PDFWorkerDouble.instances[0]);
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

    expectAllReleased();
    expect(cancel).toHaveBeenCalled();
  });

  it('terminates the worker when unmounted before the document resolves', async () => {
    getDocument.mockImplementation(() => ({ destroy, promise: new Promise(() => {}) }));

    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalled());
    expect(getPage).not.toHaveBeenCalled();
    unmount();

    expectAllReleased();
  });

  it('swallows a teardown rejection rather than leaving it unhandled', async () => {
    destroy.mockRejectedValue(new Error('worker never set up'));

    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} />, { wrapper: TestWrapper });

    await waitFor(() => expect(getPage).toHaveBeenCalled());
    expect(() => unmount()).not.toThrow();
    await expect(destroy.mock.results[0]!.value).rejects.toThrow('worker never set up');
  });

  it('renders the default error for an unrecognised failure, with technical details and a download link', async () => {
    getDocument.mockImplementation(() => ({
      destroy,
      promise: Promise.reject(new Error('Invalid parameter object')),
    }));

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('Unable to load PDF document')
    );
    expect(screen.queryByText(/Loading PDF/)).not.toBeInTheDocument();
    expect(screen.getByTestId('pdf-viewer-error-detail')).toHaveTextContent(/Reload the page/);
    expect(screen.getByTestId('pdf-viewer-error-technical')).toHaveTextContent('Error: Invalid parameter object');
    const downloadBtn = screen.getByTestId('pdf-viewer-error-download-btn');
    expect(downloadBtn).toHaveAttribute('href', FILE);
    expect(downloadBtn).toHaveAttribute('target', '_blank');
    expect(downloadBtn).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('fails fast with the worker-failure error when the worker script fails to load', async () => {
    getDocument.mockImplementation(() => ({ destroy, promise: new Promise(() => {}) }));

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    WorkerDouble.instances[0]!.dispatchEvent(new Event('error'));

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('PDF viewer stopped unexpectedly')
    );
    expect(screen.queryByText(/Loading PDF/)).not.toBeInTheDocument();
    expect(screen.getByTestId('pdf-viewer-error-technical')).toHaveTextContent(
      'PdfWorkerFailureError: PDF worker stopped (error event)'
    );
    expectAllReleased();
  });

  it('fails fast with the worker-failure error when the worker dies while a page is still rendering', async () => {
    const deferredRender = createDeferred<void>();
    const pendingPage: PageDouble = {
      getViewport: () => viewport,
      render: () => ({ promise: deferredRender.promise, cancel }) as RenderTask,
    };
    getDocument.mockImplementation(() => ({
      destroy,
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (pageNumber: number) => {
          getPage(pageNumber);
          return pendingPage as PDFPageProxy;
        },
      } as PDFDocumentProxy),
    }));

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
    // Still rendering page 1: the loading overlay is up, so the worker listeners must still be
    // attached for this to be observed rather than hanging.
    expect(screen.getByText(/Loading PDF/)).toBeInTheDocument();

    WorkerDouble.instances[0]!.dispatchEvent(new Event('error'));

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('PDF viewer stopped unexpectedly')
    );
    expect(screen.queryByText(/Loading PDF/)).not.toBeInTheDocument();
    expectAllReleased();
  });

  it('ignores a worker error event that arrives after every page has rendered', async () => {
    const PdfViewer = await importViewer();
    const { container } = render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByText(/doc\.pdf - 2 pages/)).toBeInTheDocument());
    WorkerDouble.instances[0]!.dispatchEvent(new Event('error'));
    WorkerDouble.instances[0]!.dispatchEvent(new Event('messageerror'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(screen.queryByTestId('pdf-viewer-error-title')).not.toBeInTheDocument();
    expect(screen.getByText(/doc\.pdf - 2 pages/)).toBeInTheDocument();
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    expect(destroy).not.toHaveBeenCalled();
    expect(WorkerDouble.instances[0]!.terminate).not.toHaveBeenCalled();
  });

  it('releases the loading task and both workers when the load fails, without repeating on unmount', async () => {
    getDocument.mockImplementation(() => ({
      destroy,
      promise: Promise.reject(new Error('Invalid parameter object')),
    }));

    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('Unable to load PDF document')
    );
    expectAllReleased();

    expect(() => unmount()).not.toThrow();
    expectAllReleased();
  });

  it('renders reload guidance and technical details for a worker/API version mismatch', async () => {
    const versionMismatch = new Error('The API version "6.3.289" does not match the Worker version "5.6.205".');
    versionMismatch.name = 'UnknownErrorException';
    getDocument.mockImplementation(() => ({
      destroy,
      promise: Promise.reject(versionMismatch),
    }));

    const PdfViewer = await importViewer();
    render(<PdfViewer file={FILE} filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('PDF viewer is out of date')
    );
    expect(screen.getByTestId('pdf-viewer-error-detail')).toHaveTextContent(/Reload the page/);
    expect(screen.getByTestId('pdf-viewer-error-technical')).toHaveTextContent(
      'UnknownErrorException: The API version "6.3.289" does not match the Worker version "5.6.205".'
    );
  });

  it('does not let a stale run detach the current run worker listeners once its own race finally settles (regression)', async () => {
    const deferredA = createDeferred<PDFDocumentProxy>();
    const deferredB = createDeferred<PDFDocumentProxy>();
    let callCount = 0;
    getDocument.mockImplementation(() => {
      callCount += 1;
      return { destroy, promise: callCount === 1 ? deferredA.promise : deferredB.promise };
    });

    const PdfViewer = await importViewer();
    const { rerender } = render(<PdfViewer file={FILE} filename="a.pdf" />, { wrapper: TestWrapper });
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));

    rerender(<PdfViewer file={FILE_B} filename="b.pdf" />);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));

    // File A's load settles only after its effect was already cancelled in favor of file B.
    deferredA.resolve(makeDocument(1) as PDFDocumentProxy);
    await new Promise(resolve => setTimeout(resolve, 0));

    // File B's worker now dies. A per-run bug would let A's late continuation detach B's
    // listeners first, so B's load would hang forever instead of surfacing this.
    WorkerDouble.instances[1]!.dispatchEvent(new Event('error'));

    await waitFor(() =>
      expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('PDF viewer stopped unexpectedly')
    );
    expect(WorkerDouble.instances[1]!.terminate).toHaveBeenCalledTimes(1);
    expect(PDFWorkerDouble.instances[1]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports an error when no file is supplied', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={undefined} />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByTestId('pdf-viewer-error-title')).toHaveTextContent('No file provided'));
    expect(getDocument).not.toHaveBeenCalled();
  });
});
