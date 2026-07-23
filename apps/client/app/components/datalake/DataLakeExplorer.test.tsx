import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeExplorer from './DataLakeExplorer';

// The browse hooks hit react-query; stub them to an empty, non-loading result so the
// explorer renders its header without a QueryClientProvider.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetDataLakeTagCounts: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetDataLakeArticles: () => ({ data: undefined }),
}));

// Heavy children are irrelevant to the header assertion - keep them inert.
vi.mock('./DataLakeTree', () => ({ default: () => null }));
vi.mock('./DataLakeArticle', () => ({ default: () => null }));
vi.mock('@client/app/components/DataLakeWizard/DataLakeIngestPickerModal', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeExplorer - persistent Data Lakes info tooltip (#834)', () => {
  it('shows a persistent info icon next to the header that reveals the RAG explanation on hover', async () => {
    render(
      <Wrapper>
        <DataLakeExplorer onBack={vi.fn()} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-data-lake-explorer');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Help: Data Lakes');

    fireEvent.mouseOver(trigger);
    expect(
      await screen.findByText(/curated knowledge base the AI grounds its answers in \(RAG\)/i)
    ).toBeInTheDocument();
  });
});
