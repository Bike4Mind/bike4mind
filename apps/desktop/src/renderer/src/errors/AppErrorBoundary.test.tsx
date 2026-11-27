// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererErrorReport } from '@shared/appShell';
import { AppErrorBoundary } from './AppErrorBoundary';
import { AppErrorFallback } from './AppErrorFallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Joy's CssVarsProvider reads the system colour scheme; jsdom has no matchMedia.
window.matchMedia = (query => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

function Exploding(): never {
  throw new Error('the sidebar fell over');
}

describe('app error boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  const reportRendererError = vi.fn(async (_report: RendererErrorReport): Promise<void> => undefined);
  const writeText = vi.fn(async (_text: string): Promise<void> => undefined);

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    reportRendererError.mockClear();
    writeText.mockReset().mockResolvedValue(undefined);
    (window as unknown as { b4m: unknown }).b4m = { reportRendererError };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // React logs every caught render error; the boundary is meant to catch this one.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (window as unknown as { b4m?: unknown }).b4m;
  });

  const find = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('replaces a crashed tree with the fallback and logs the error to main', () => {
    act(() =>
      root.render(
        <CssVarsProvider>
          <AppErrorBoundary>
            <Exploding />
          </AppErrorBoundary>
        </CssVarsProvider>
      )
    );

    expect(find('app-error-fallback')).not.toBeNull();
    expect(find('app-error-message')?.textContent).toBe('the sidebar fell over');
    expect(reportRendererError).toHaveBeenCalledTimes(1);
    const report = reportRendererError.mock.calls[0]?.[0];
    expect(report?.message).toBe('the sidebar fell over');
    expect(report?.stack).toContain('the sidebar fell over');
    expect(report?.componentStack).toContain('Exploding');
  });

  it('leaves a healthy tree alone', () => {
    act(() =>
      root.render(
        <AppErrorBoundary>
          <p data-testid="healthy">fine</p>
        </AppErrorBoundary>
      )
    );
    expect(find('healthy')).not.toBeNull();
    expect(find('app-error-fallback')).toBeNull();
    expect(reportRendererError).not.toHaveBeenCalled();
  });

  it('reloads from the Reload button', () => {
    const reload = vi.fn();
    act(() => root.render(<AppErrorFallback error={new Error('boom')} reload={reload} />));
    act(() => find('app-error-reload-btn')?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('copies the message, stack and component stack', async () => {
    const error = new Error('boom');
    act(() => root.render(<AppErrorFallback error={error} componentStack={'\n    at Sidebar'} />));
    await act(async () => find('app-error-copy-btn')?.click());

    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('Error: boom');
    expect(copied).toContain(error.stack ?? 'missing stack');
    expect(copied).toContain('Component stack:\n    at Sidebar');
    expect(find('app-error-copy-btn')?.textContent).toBe('Copied');
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    act(() => root.render(<AppErrorFallback error="a thrown string" />));
    expect(find('app-error-message')?.textContent).toBe('a thrown string');
    await act(async () => find('app-error-copy-btn')?.click());
    expect(find('app-error-copy-btn')?.textContent).toBe('Copy failed');
  });
});
