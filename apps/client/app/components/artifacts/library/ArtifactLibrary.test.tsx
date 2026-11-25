// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/app/contexts/ApiContext', () => ({ api: { get: h.get } }));
vi.mock('@tanstack/react-router', async () => {
  const ReactModule = await import('react');
  return {
    Link: ReactModule.forwardRef<HTMLAnchorElement, { to: string } & Record<string, unknown>>(
      ({ to, ...rest }, ref) => <a ref={ref} href={to} {...rest} />
    ),
  };
});

import { ArtifactLibrary } from './ArtifactLibrary';

const appTheme = extendTheme({ ...getThemeConfig() });

const artifact = (index: number, extra: Record<string, unknown> = {}) => ({
  id: `artifact_html_item-${index}_1700000000000_${index}`,
  type: 'html',
  title: `Artifact ${index}`,
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

const page = (artifacts: unknown[], offset: number, hasMore: boolean) => ({
  data: { artifacts, pagination: { total: 99, limit: 20, offset, hasMore } },
});

const renderLibrary = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <ArtifactLibrary />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const requestedParams = (callIndex: number) =>
  new URLSearchParams(String(h.get.mock.calls[callIndex][0]).split('?')[1] ?? '');

describe('ArtifactLibrary', () => {
  beforeEach(() => {
    h.get.mockReset();
  });

  it('shows the empty state when the user has no artifacts', async () => {
    h.get.mockResolvedValueOnce(page([], 0, false));
    renderLibrary();

    expect(await screen.findByTestId('artifact-library-empty')).toHaveTextContent('No artifacts yet');
    expect(screen.queryByTestId('artifact-library-load-more-btn')).toBeNull();
  });

  it('lists artifacts newest first, each linking to its own page with where it came from', async () => {
    h.get.mockResolvedValueOnce(
      page(
        [
          artifact(1, { sessionId: 'session-1' }),
          artifact(2, { projectId: 'project-1' }),
          artifact(3, { title: 'Desktop Mods' }),
        ],
        0,
        false
      )
    );
    renderLibrary();

    const links = await screen.findAllByTestId('artifact-library-item-link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', '/artifacts/artifact_html_item-1_1700000000000_1');
    expect(links[0]).toHaveTextContent('Notebook');
    expect(links[1]).toHaveTextContent('Project');
    expect(links[2]).toHaveTextContent('Desktop Mods');
    expect(links[2]).toHaveTextContent('Standalone');

    const params = requestedParams(0);
    expect(params.get('sortBy')).toBe('updatedAt');
    expect(params.get('sortOrder')).toBe('desc');
    expect(params.get('offset')).toBe('0');
  });

  it('loads the next page from the offset after the rows already shown', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => artifact(index));
    h.get.mockResolvedValueOnce(page(firstPage, 0, true)).mockResolvedValueOnce(page([artifact(20)], 20, false));
    renderLibrary();

    fireEvent.click(await screen.findByTestId('artifact-library-load-more-btn'));

    await waitFor(() => expect(screen.getAllByTestId('artifact-library-item-link')).toHaveLength(21));
    expect(requestedParams(1).get('offset')).toBe('20');
    expect(screen.queryByTestId('artifact-library-load-more-btn')).toBeNull();
  });

  it('shows a row once when it shifts onto the next page between loads', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => artifact(index));
    h.get
      .mockResolvedValueOnce(page(firstPage, 0, true))
      .mockResolvedValueOnce(page([artifact(19), artifact(20)], 20, false));
    renderLibrary();

    fireEvent.click(await screen.findByTestId('artifact-library-load-more-btn'));

    await waitFor(() => expect(screen.getAllByTestId('artifact-library-item-link')).toHaveLength(21));
  });

  it('sends the search term to the list endpoint', async () => {
    h.get.mockResolvedValue(page([], 0, false));
    renderLibrary();
    await screen.findByTestId('artifact-library-empty');

    // Skips the 300ms search debounce; shouldAdvanceTime keeps waitFor's own timers moving.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(screen.getByTestId('artifact-library-search-input'), { target: { value: 'mods' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
      expect(requestedParams(1).get('search')).toBe('mods');
      expect(await screen.findByTestId('artifact-library-empty')).toHaveTextContent('No artifacts match');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error when the list fails to load', async () => {
    h.get.mockRejectedValueOnce(new Error('boom'));
    renderLibrary();

    expect(await screen.findByTestId('artifact-library-error')).toBeInTheDocument();
  });
});
