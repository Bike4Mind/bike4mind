import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { KnowledgeChunkControls } from './KnowledgeChunkControls';

const chunkFileUtility = vi.fn().mockResolvedValue(undefined);

vi.mock('@client/app/utils/filesAPICalls', () => ({
  chunkFileUtility: (...args: unknown[]) => chunkFileUtility(...args),
  updateFileUtility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => undefined,
}));

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const FAB_FILE = {
  id: 'f1',
  fileName: 'doc.txt',
  isChunking: false,
  isVectorizing: false,
  chunked: false,
  vectorized: false,
} as never;

describe('KnowledgeChunkControls - chunk-size ceiling', () => {
  beforeEach(() => {
    chunkFileUtility.mockClear();
  });

  it('clamps a chunk size above the detection threshold before sending it', async () => {
    render(
      <TestWrapper>
        <KnowledgeChunkControls fabFile={FAB_FILE} />
      </TestWrapper>
    );

    const input = screen.getByTestId('knowledge-chunk-controls-size-input').querySelector('input')!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('1500 tokens');

    fireEvent.click(screen.getByTestId('knowledge-chunk-controls-chunk-btn'));

    await waitFor(() => expect(chunkFileUtility).toHaveBeenCalledWith('f1', 1500));
  });

  it('leaves an in-range chunk size unchanged', async () => {
    render(
      <TestWrapper>
        <KnowledgeChunkControls fabFile={FAB_FILE} />
      </TestWrapper>
    );

    const input = screen.getByTestId('knowledge-chunk-controls-size-input').querySelector('input')!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '800' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('800 tokens');

    fireEvent.click(screen.getByTestId('knowledge-chunk-controls-chunk-btn'));

    await waitFor(() => expect(chunkFileUtility).toHaveBeenCalledWith('f1', 800));
  });

  it('falls back to the last valid size on a blank blur instead of committing NaN', async () => {
    render(
      <TestWrapper>
        <KnowledgeChunkControls fabFile={FAB_FILE} />
      </TestWrapper>
    );

    const input = screen.getByTestId('knowledge-chunk-controls-size-input').querySelector('input')!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(input).not.toHaveValue('NaN tokens');

    fireEvent.click(screen.getByTestId('knowledge-chunk-controls-chunk-btn'));

    await waitFor(() => expect(chunkFileUtility).toHaveBeenCalled());
    const [, sentChunkSize] = chunkFileUtility.mock.calls[0];
    expect(Number.isNaN(sentChunkSize)).toBe(false);
  });
});
