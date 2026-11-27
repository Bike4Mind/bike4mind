import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DownloadMenu from './DownloadMenu';

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderMenu = (props: Partial<React.ComponentProps<typeof DownloadMenu>> = {}) =>
  render(<DownloadMenu content="" fileName="reply.md" {...props} />, { wrapper: Wrapper });

// The MenuButton is this component's only button when rendered in isolation.
const openMenu = () => fireEvent.click(screen.getByRole('button'));

const CSV_REPLY = ['Here is the data:', '```csv', 'a,b,c', '1,2,3', '```'].join('\n');
const PYTHON_REPLY = ['```python', 'def main():', '    print("hi")', '```'].join('\n');
const PROSE_REPLY = 'Sure, here is a plain explanation with no code blocks at all.';

// jsdom implements neither URL method; downloadFile() (used by every menu item) calls both.
// The anchor itself is captured via document.createElement rather than `this` inside the
// click spy, since aliasing `this` to a variable trips @typescript-eslint/no-this-alias.
function stubDownloadApis() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url');
  const revokeObjectURL = vi.fn((_url: string) => undefined);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  const anchors: HTMLAnchorElement[] = [];
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const el = realCreateElement(tagName, options);
    if (tagName === 'a') anchors.push(el as HTMLAnchorElement);
    return el;
  }) as typeof document.createElement);

  return { createObjectURL, revokeObjectURL, getAnchor: () => anchors[anchors.length - 1] };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.values(toastMock).forEach(mock => mock.mockClear());
});

describe('DownloadMenu', () => {
  it('does not compute or render detected items before the menu is opened', () => {
    renderMenu({ content: CSV_REPLY });
    expect(screen.queryAllByTestId(/^download-menu-detected-/)).toHaveLength(0);
  });

  it('opening the menu on a csv-fenced reply renders a detected item above the static ones', () => {
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md' });
    openMenu();

    const detected = screen.queryAllByTestId(/^download-menu-detected-/);
    expect(detected).toHaveLength(1);
    expect(detected[0].getAttribute('data-testid')).toBe('download-menu-detected-reply-1.csv');
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('opening the menu on a prose reply with no fences renders only the three static items', () => {
    renderMenu({ content: PROSE_REPLY });
    openMenu();

    expect(screen.queryAllByTestId(/^download-menu-detected-/)).toHaveLength(0);
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('clicking a detected item downloads its own content under its own filename and mime type', () => {
    const { createObjectURL, revokeObjectURL, getAnchor } = stubDownloadApis();
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md' });
    openMenu();
    fireEvent.click(screen.getByTestId('download-menu-detected-reply-1.csv'));

    expect(getAnchor()?.download).toBe('reply-1.csv');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0].type).toBe('text/csv');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('a python fence produces a detected entry whose filename ends .py', () => {
    renderMenu({ content: PYTHON_REPLY, fileName: 'reply.md' });
    openMenu();

    const detected = screen.queryAllByTestId(/^download-menu-detected-/);
    expect(detected).toHaveLength(1);
    expect(detected[0].getAttribute('data-testid')).toMatch(/\.py$/);
  });

  it('clicking a detected item calls onClose', () => {
    stubDownloadApis();
    const onClose = vi.fn();
    renderMenu({ content: CSV_REPLY, fileName: 'reply.md', onClose });
    openMenu();
    fireEvent.click(screen.getByTestId('download-menu-detected-reply-1.csv'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('html artifact items', () => {
    const HTML_REPLY = [
      'Here is the chart:',
      '<artifact type="text/html" title="Sales Chart">',
      '<html><body><canvas id="c"></canvas><script src="/static/lib/chart.js@4.x.js"></script></body></html>',
      '</artifact>',
    ].join('\n');

    const blobText = (blob: Blob) =>
      new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });

    it('downloads the html with the blessed library inlined instead of a root-relative src', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, text: async () => 'window.Chart = {};' }) as Response)
      );
      const { createObjectURL, getAnchor } = stubDownloadApis();
      const onClose = vi.fn();
      renderMenu({ content: HTML_REPLY, fileName: 'reply.md', onClose });
      openMenu();
      fireEvent.click(screen.getByTestId('download-menu-detected-sales-chart.html'));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      const blob = createObjectURL.mock.calls[0][0];
      const text = await blobText(blob);
      expect(blob.type).toBe('text/html');
      expect(getAnchor()?.download).toBe('sales-chart.html');
      expect(text).not.toContain('src="/static/lib/');
      expect(text).toContain('<script>window.Chart = {};</script>');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores a second trigger while the first download is still being prepared', async () => {
      let release: (response: Response) => void = () => undefined;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>(resolve => {
            release = resolve;
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const { createObjectURL } = stubDownloadApis();
      const onClose = vi.fn();
      renderMenu({ content: HTML_REPLY, fileName: 'reply.md', onClose });
      openMenu();
      fireEvent.click(screen.getByTestId('download-menu-detected-sales-chart.html'));

      // The menu closes on pick, so reopen it for the second trigger.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      if (!screen.queryByTestId('download-menu-detected-sales-chart.html')) openMenu();
      fireEvent.click(await screen.findByTestId('download-menu-detected-sales-chart.html'));

      expect(toastMock.info).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();

      release({ ok: true, status: 200, text: async () => 'window.Chart = {};' } as Response);
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      expect(onClose).toHaveBeenCalledTimes(1);

      // The guard clears once the download finishes.
      if (!screen.queryByTestId('download-menu-detected-sales-chart.html')) openMenu();
      fireEvent.click(await screen.findByTestId('download-menu-detected-sales-chart.html'));
      release({ ok: true, status: 200, text: async () => 'window.Chart = {};' } as Response);
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    });

    it('reports a failed download with an error toast and releases the in-flight guard', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, text: async () => 'window.Chart = {};' }) as Response)
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { createObjectURL } = stubDownloadApis();
      createObjectURL.mockImplementationOnce(() => {
        throw new Error('blob failed');
      });
      const onClose = vi.fn();
      renderMenu({ content: HTML_REPLY, fileName: 'reply.md', onClose });
      openMenu();
      fireEvent.click(screen.getByTestId('download-menu-detected-sales-chart.html'));

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Failed to download HTML'));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(toastMock.dismiss).toHaveBeenCalled();

      if (!screen.queryByTestId('download-menu-detected-sales-chart.html')) openMenu();
      fireEvent.click(await screen.findByTestId('download-menu-detected-sales-chart.html'));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
      expect(toastMock.info).not.toHaveBeenCalled();
    });

    it('shows a loading toast only when preparing takes a while, and dismisses it afterwards', async () => {
      vi.useFakeTimers();
      try {
        let release: (response: Response) => void = () => undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(
            () =>
              new Promise<Response>(resolve => {
                release = resolve;
              })
          )
        );
        const { createObjectURL } = stubDownloadApis();
        renderMenu({ content: HTML_REPLY, fileName: 'reply.md' });
        openMenu();
        fireEvent.click(screen.getByTestId('download-menu-detected-sales-chart.html'));

        await vi.advanceTimersByTimeAsync(100);
        expect(toastMock.loading).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(400);
        expect(toastMock.loading).toHaveBeenCalledTimes(1);

        release({ ok: true, status: 200, text: async () => 'window.Chart = {};' } as Response);
        await vi.advanceTimersByTimeAsync(0);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(toastMock.dismiss).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still downloads when the library cannot be fetched, with an absolute src', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('offline');
        })
      );
      const { createObjectURL } = stubDownloadApis();
      renderMenu({ content: HTML_REPLY, fileName: 'reply.md' });
      openMenu();
      fireEvent.click(screen.getByTestId('download-menu-detected-sales-chart.html'));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      const text = await blobText(createObjectURL.mock.calls[0][0]);
      expect(text).not.toContain('src="/static/lib/');
      expect(text).toContain(`src="${window.location.origin}/static/lib/chart.js@4.x.js"`);
    });
  });
});
