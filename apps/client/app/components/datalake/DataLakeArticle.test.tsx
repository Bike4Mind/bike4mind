import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeArticle from './DataLakeArticle';
import { DEFAULT_DATA_LAKE_SURFACE_TOKENS } from './surfaceTokens';

// The content hook hits react-query; stub it so the empty state renders without a provider.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const { copy } = DEFAULT_DATA_LAKE_SURFACE_TOKENS;

describe('DataLakeArticle - create-first empty state (#837)', () => {
  it('renders a create CTA in the true zero-lake state and invokes it', () => {
    const onCreate = vi.fn();
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} emptyVariant="no-lakes" onCreate={onCreate} />
      </Wrapper>
    );

    expect(screen.getByText(copy.zeroTitle)).toBeInTheDocument();
    const cta = screen.getByTestId('datalake-empty-create-btn');
    fireEvent.click(cta);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the default idle copy and no CTA when no variant is given', () => {
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-empty-create-btn')).not.toBeInTheDocument();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });
});

describe('DataLakeArticle - the empty state cannot claim a zero-lake state it was not told about (#1645)', () => {
  it('withholds the create CTA when onCreate is set but the variant is not the zero-lake one', () => {
    // The regression pin. The CTA used to key off onCreate's mere presence, and the page passed it
    // whenever the file scope was empty - so a user with lakes was invited to create their first.
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} emptyVariant="no-selection" onCreate={vi.fn()} />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-empty-create-btn')).not.toBeInTheDocument();
    expect(screen.queryByText(copy.zeroTitle)).not.toBeInTheDocument();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it('offers a retry (and never the create CTA) when the lake list could not be read', () => {
    const onRetryLakes = vi.fn();
    render(
      <Wrapper>
        <DataLakeArticle
          file={null}
          onAskAbout={vi.fn()}
          emptyVariant="lakes-error"
          onCreate={vi.fn()}
          onRetryLakes={onRetryLakes}
        />
      </Wrapper>
    );

    expect(screen.getByText(copy.lakesErrorTitle)).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-empty-create-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('datalake-empty-retry-btn'));
    expect(onRetryLakes).toHaveBeenCalledTimes(1);
  });

  it('offers add-files for an empty selected lake, rather than creating another one', () => {
    const onAddFiles = vi.fn();
    render(
      <Wrapper>
        <DataLakeArticle
          file={null}
          onAskAbout={vi.fn()}
          emptyVariant="lake-empty"
          onCreate={vi.fn()}
          onAddFiles={onAddFiles}
        />
      </Wrapper>
    );

    expect(screen.getByText(copy.lakeEmptyTitle)).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-empty-create-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('datalake-empty-addfiles-btn'));
    expect(onAddFiles).toHaveBeenCalledTimes(1);
  });

  it('hides the browse shortcuts in every state that has nothing to browse', () => {
    // Category chips beside "you have no lakes" is the same contradiction in a different place.
    const dives = [{ path: ['legal', 'contracts'], segment: 'contracts', count: 4 }];
    for (const variant of ['no-lakes', 'lakes-error', 'lake-empty', 'all-lakes-empty'] as const) {
      const { unmount } = render(
        <Wrapper>
          <DataLakeArticle
            file={null}
            onAskAbout={vi.fn()}
            emptyVariant={variant}
            quickDives={dives}
            onDive={vi.fn()}
          />
        </Wrapper>
      );
      expect(screen.queryByTestId('datalake-dive-legal-contracts')).not.toBeInTheDocument();
      unmount();
    }

    render(
      <Wrapper>
        <DataLakeArticle
          file={null}
          onAskAbout={vi.fn()}
          emptyVariant="no-selection"
          quickDives={dives}
          onDive={vi.fn()}
        />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-dive-legal-contracts')).toBeInTheDocument();
  });
});
