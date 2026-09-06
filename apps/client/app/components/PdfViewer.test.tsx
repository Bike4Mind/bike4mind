import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// pdf.js v6 removed the two calling conventions this component used to rely on: `getDocument`
// no longer accepts a bare URL string, and `PDFDocumentProxy.destroy` is gone in favour of
// `loadingTask.destroy`. The real v6 build cannot run here (its worker needs browser-only
// features jsdom lacks), so the double is shaped like v6 exactly: a string argument or a
// `pdf.destroy()` call would be a hard failure against the real library.
const destroy = vi.fn().mockResolvedValue(undefined);
const cancel = vi.fn();
const getPage = vi.fn();
const getDocument = vi.fn();

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocument(...args),
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

const importViewer = async () => (await import('./PdfViewer')).default;

describe('PdfViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getPage.mockImplementation(async () => ({
      getViewport: () => ({ width: 120, height: 160 }),
      render: () => ({ promise: Promise.resolve(), cancel }),
    }));

    getDocument.mockImplementation(() => {
      const loadingTask: Record<string, unknown> = { destroy };
      loadingTask.promise = Promise.resolve({ numPages: 2, getPage, loadingTask });
      return loadingTask;
    });

    // jsdom has no 2D backend; the component bails out when getContext returns null.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });

  it('passes the file to getDocument as a parameter object', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file="https://example.test/doc.pdf" filename="doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    expect(getDocument).toHaveBeenCalledWith({ url: 'https://example.test/doc.pdf' });
  });

  it('renders every page and reports the page count', async () => {
    const PdfViewer = await importViewer();
    const { container } = render(<PdfViewer file="https://example.test/doc.pdf" filename="doc.pdf" />, {
      wrapper: TestWrapper,
    });

    await waitFor(() => expect(screen.getByText(/doc\.pdf - 2 pages/)).toBeInTheDocument());
    expect(getPage.mock.calls.map(([n]) => n)).toEqual([1, 2]);
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
  });

  it('tears the document down through the loading task on unmount', async () => {
    const PdfViewer = await importViewer();
    const { unmount } = render(<PdfViewer file="https://example.test/doc.pdf" />, { wrapper: TestWrapper });

    await waitFor(() => expect(getPage).toHaveBeenCalled());
    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('reports an error when no file is supplied', async () => {
    const PdfViewer = await importViewer();
    render(<PdfViewer file={undefined} />, { wrapper: TestWrapper });

    await waitFor(() => expect(screen.getByText(/Unable to load PDF|No file provided/)).toBeInTheDocument());
    expect(getDocument).not.toHaveBeenCalled();
  });
});
